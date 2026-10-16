using System;
using System.IO;
using System.Threading.Tasks;
using LibVLCSharp.Platforms.Windows;
using Microsoft.Web.WebView2.Core;
using Iptv.Bridge;
using Iptv.Diagnostics;
using Iptv.Input;
using Iptv.Playback;
using Windows.ApplicationModel;
using Windows.Storage;
using Windows.System;
using Windows.UI.Core;
using Windows.UI.ViewManagement;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Input;
using Windows.UI.Xaml.Markup;
using Windows.UI.Xaml.Media;
using Windows.UI.Xaml.Navigation;

namespace Iptv
{
    /// <summary>
    /// The IPTV web app (web/ in the repository, packaged into the app) runs in a WebView2 on top
    /// of a VLC video surface, and plays streams with VLC through <see cref="AppBridge"/>.
    /// </summary>
    public sealed partial class MainPage : Page, IAppHost
    {
        /// <summary>The packaged web app is served from this made-up https origin.</summary>
        private const string BundledHost = "app.iptv.local";
        private static readonly Uri BundledUri = new Uri("https://" + BundledHost + "/index.html");
        private const string WebAppUrlSetting = "webAppUrl";

        private readonly VlcPlayer _player;
        private AppBridge _bridge;
        private ControllerBridge _controller;
        private Uri _appUri;
        private bool _servingBundleManually;
        private ulong _appNavigationId;
        private bool _videoViewRequested;
        private bool _videoViewStarting;
        private bool _dialogOpen;

        // Where the page wants the picture (player.layout) and whether VLC has frames to show.
        private bool _videoVisible;
        private bool _layoutVisible = true;
        private bool _layoutSet;
        private double _layoutX;
        private double _layoutY;
        private double _layoutWidth;
        private double _layoutHeight;
        private double _layoutViewWidth;
        private double _layoutViewHeight;
        private string _layoutScaleLogged;

        public MainPage()
        {
            Log.Write("Main page starting");
            this.InitializeComponent();
            _player = new VlcPlayer(Dispatcher);
            _player.MediaPlayerCreated += mediaPlayer =>
            {
                if (VideoView != null)
                {
                    VideoView.MediaPlayer = mediaPlayer;
                }
            };
            _player.VideoVisibleChanged += visible =>
            {
                _videoVisible = visible;
                ApplyVideoLayout();
            };
            // The page has its own focus navigation for the controller; the console's mouse-mode
            // cursor would only get in the way. The web app can turn it back on.
            SetPointerMode(false);
            PreviewKeyDown += OnPreviewKeyDown;
            Loaded += OnLoaded;
        }

        public string WebAppUrl
        {
            get
            {
                return ApplicationData.Current.LocalSettings.Values[WebAppUrlSetting] as string;
            }
        }

        public bool IsBundledWebApp
        {
            get { return _appUri == null || _appUri.Host == BundledHost; }
        }

        /// <summary>
        /// Called for an unhandled exception. If it came from the VLC video surface while it was
        /// starting, drop the surface and keep the app running without VLC playback.
        /// </summary>
        internal bool TryRecoverFromVideoFailure(Exception error)
        {
            if (!_videoViewStarting)
            {
                return false;
            }
            _videoViewStarting = false;
            Log.Write("The VLC video surface failed to start; continuing without VLC playback");
            try
            {
                if (VideoView != null)
                {
                    XamlMarkupHelper.UnloadObject(VideoView);
                }
            }
            catch (Exception ex)
            {
                Log.Error("Removing the VLC video surface failed", ex);
            }
            _player.SetUnavailable("the video surface failed to start (" + error.Message + ")");
            return true;
        }

        protected override void OnNavigatedFrom(NavigationEventArgs e)
        {
            base.OnNavigatedFrom(e);
            SystemNavigationManager.GetForCurrentView().BackRequested -= OnBackRequested;
            Window.Current.VisibilityChanged -= OnWindowVisibilityChanged;
            _controller?.Dispose();
            _bridge?.Dispose();
            _player.Dispose();
#if DEBUG
            _devCommands?.Stop();
#endif
        }

        private async void OnLoaded(object sender, RoutedEventArgs e)
        {
            Loaded -= OnLoaded;
            Log.Write("Main page loaded, starting WebView2");
            SystemNavigationManager.GetForCurrentView().BackRequested += OnBackRequested;
            Window.Current.VisibilityChanged += OnWindowVisibilityChanged;
            try
            {
                await WebView.EnsureCoreWebView2Async();
            }
            catch (Exception ex)
            {
                Log.Error("WebView2 failed to start", ex);
                ShowLoadError("The web view could not start. " + ex.Message, false);
                return;
            }
            Log.Write("WebView2 ready");

            var core = WebView.CoreWebView2;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            // No browser shortcuts such as the back key: B is handled by ControllerBridge only.
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsPinchZoomEnabled = false;
#if !DEBUG
            core.Settings.AreDevToolsEnabled = false;
#endif
            core.NavigationStarting += OnNavigationStarting;
            core.NavigationCompleted += OnNavigationCompleted;
            core.NewWindowRequested += OnNewWindowRequested;
            core.ProcessFailed += OnProcessFailed;
            ServeBundledApp(core);

            _appUri = ChooseAppUri();
            // Must be listening before the page loads: the web app says hello as soon as it starts.
            _bridge = new AppBridge(core, _player, this, _appUri);
            _controller = new ControllerBridge((action, repeat) => _bridge.SendInput(action, repeat));
#if DEBUG
            StartDevCommands(core);
#endif
            Log.Write("Loading " + Log.DescribeUrl(_appUri.AbsoluteUri));
            core.Navigate(_appUri.AbsoluteUri);
            WebView.Focus(FocusState.Programmatic);
        }

#if DEBUG
        // Debug builds only: a script saved in the app's LocalState folder as dev-command.js is run
        // in the page and its result written next to it as dev-result.json. tools/dev-page.mjs uses
        // this to drive and inspect the app on a PC, where nothing outside the app can connect to it.
        private DispatcherTimer _devCommands;

        private void StartDevCommands(CoreWebView2 core)
        {
            var folder = ApplicationData.Current.LocalFolder.Path;
            var commandPath = Path.Combine(folder, "dev-command.js");
            var resultPath = Path.Combine(folder, "dev-result.json");
            var busy = false;
            _devCommands = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(300) };
            _devCommands.Tick += async (s, e) =>
            {
                if (busy || !File.Exists(commandPath))
                {
                    return;
                }
                busy = true;
                try
                {
                    string script;
                    try
                    {
                        script = File.ReadAllText(commandPath);
                        File.Delete(commandPath);
                    }
                    catch (IOException)
                    {
                        return; // Still being written; next tick.
                    }
                    string result;
                    try
                    {
                        // "#cdp Method {json}" calls the DevTools protocol instead, e.g. to lay the
                        // page out at another size, as on Xbox.
                        if (script.StartsWith("#cdp ", StringComparison.Ordinal))
                        {
                            var rest = script.Substring(5).Trim();
                            var space = rest.IndexOf(' ');
                            var method = space < 0 ? rest : rest.Substring(0, space);
                            var parameters = space < 0 ? "{}" : rest.Substring(space + 1);
                            result = await core.CallDevToolsProtocolMethodAsync(method, parameters);
                        }
                        else
                        {
                            result = await core.ExecuteScriptAsync(script);
                        }
                    }
                    catch (Exception ex)
                    {
                        result = "{\"devError\":" + Windows.Data.Json.JsonValue.CreateStringValue(ex.Message).Stringify() + "}";
                    }
                    File.WriteAllText(resultPath + ".tmp", result ?? "null");
                    if (File.Exists(resultPath))
                    {
                        File.Delete(resultPath);
                    }
                    File.Move(resultPath + ".tmp", resultPath);
                }
                catch (Exception ex)
                {
                    Log.Error("Dev command failed", ex);
                }
                finally
                {
                    busy = false;
                }
            };
            _devCommands.Start();
        }
#endif

        private Uri ChooseAppUri()
        {
            Uri custom;
            var url = WebAppUrl;
            if (!string.IsNullOrWhiteSpace(url) && Uri.TryCreate(url, UriKind.Absolute, out custom) &&
                (custom.Scheme == Uri.UriSchemeHttp || custom.Scheme == Uri.UriSchemeHttps))
            {
                return custom;
            }
            return BundledUri;
        }

        // Serves the web/ folder of the package at https://app.iptv.local/. The browser maps the
        // folder itself when it can; otherwise the files are answered from here.
        private void ServeBundledApp(CoreWebView2 core)
        {
            var folder = Path.Combine(Package.Current.InstalledLocation.Path, "web");
            try
            {
                core.SetVirtualHostNameToFolderMapping(BundledHost, folder, CoreWebView2HostResourceAccessKind.Allow);
                Log.Write("Serving the web app from " + folder);
            }
            catch (Exception ex)
            {
                Log.Error("Folder mapping is unavailable, serving the web app from the app", ex);
                ServeBundleManually(core);
            }
        }

        private void ServeBundleManually(CoreWebView2 core)
        {
            if (_servingBundleManually)
            {
                return;
            }
            _servingBundleManually = true;
            core.AddWebResourceRequestedFilter("https://" + BundledHost + "/*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += OnBundleResourceRequested;
        }

        private async void OnBundleResourceRequested(CoreWebView2 sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            Uri uri;
            if (!Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out uri) || uri.Host != BundledHost)
            {
                return;
            }
            var deferral = e.GetDeferral();
            try
            {
                var path = Uri.UnescapeDataString(uri.AbsolutePath).TrimStart('/');
                if (path.Length == 0)
                {
                    path = "index.html";
                }
                if (path.Contains(".."))
                {
                    e.Response = sender.Environment.CreateWebResourceResponse(null, 403, "Forbidden", string.Empty);
                    return;
                }
                StorageFile file;
                try
                {
                    file = await StorageFile.GetFileFromApplicationUriAsync(new Uri("ms-appx:///web/" + path));
                }
                catch (FileNotFoundException)
                {
                    e.Response = sender.Environment.CreateWebResourceResponse(null, 404, "Not Found", string.Empty);
                    return;
                }
                // A native WinRT stream: a wrapped .NET stream is read back through the UI thread.
                var stream = await file.OpenReadAsync();
                e.Response = sender.Environment.CreateWebResourceResponse(stream, 200, "OK",
                    "Content-Type: " + ContentTypeFor(path) + "\nCache-Control: no-cache");
            }
            catch (Exception ex)
            {
                Log.Error("Serving " + e.Request.Uri + " failed", ex);
            }
            finally
            {
                deferral.Complete();
            }
        }

        private static string ContentTypeFor(string path)
        {
            switch (Path.GetExtension(path).ToLowerInvariant())
            {
                case ".html": return "text/html; charset=utf-8";
                case ".js": case ".mjs": return "text/javascript; charset=utf-8";
                case ".css": return "text/css; charset=utf-8";
                case ".json": case ".webmanifest": return "application/json; charset=utf-8";
                case ".svg": return "image/svg+xml";
                case ".png": return "image/png";
                case ".jpg": case ".jpeg": return "image/jpeg";
                case ".webp": return "image/webp";
                case ".ico": return "image/x-icon";
                case ".woff2": return "font/woff2";
                case ".woff": return "font/woff";
                case ".ttf": return "font/ttf";
                default: return "application/octet-stream";
            }
        }

        public void SetPointerMode(bool enabled)
        {
            Log.Write("Pointer mode " + (enabled ? "on" : "off"));
            var mode = enabled ? RequiresPointer.WhenFocused : RequiresPointer.Never;
            RequiresPointer = mode;
            WebView.RequiresPointer = mode;
        }

        public void SetWebAppUrl(string url)
        {
            if (string.IsNullOrWhiteSpace(url))
            {
                ApplicationData.Current.LocalSettings.Values.Remove(WebAppUrlSetting);
                Log.Write("Using the built-in web app");
            }
            else
            {
                ApplicationData.Current.LocalSettings.Values[WebAppUrlSetting] = url.Trim();
                Log.Write("Using the web app at " + Log.DescribeUrl(url));
            }
            ReloadPage();
        }

        public void SetVideoLayout(bool visible, double x, double y, double width, double height,
            double viewWidth, double viewHeight)
        {
            _layoutSet = true;
            _layoutVisible = visible && width >= 1 && height >= 1;
            _layoutX = x;
            _layoutY = y;
            _layoutWidth = width;
            _layoutHeight = height;
            _layoutViewWidth = viewWidth;
            _layoutViewHeight = viewHeight;
            ApplyVideoLayout();
        }

        // Puts VLC's picture where the page's video box is: a small preview on the Live TV page,
        // the whole screen in the player. The box is in the page's pixels, which aren't XAML's on
        // every device: on Xbox the page is laid out at 1280x720 while XAML works in 960x540. So it
        // is scaled by the web view's size over the page's, and a box that covers the whole page
        // simply fills the window.
        private void ApplyVideoLayout()
        {
            if (VideoView == null)
            {
                return;
            }
            var viewWidth = WebView.ActualWidth;
            var viewHeight = WebView.ActualHeight;
            var full = !_layoutSet ||
                (_layoutX <= 1 && _layoutY <= 1 &&
                 _layoutViewWidth > 0 && _layoutX + _layoutWidth >= _layoutViewWidth - 1 &&
                 _layoutViewHeight > 0 && _layoutY + _layoutHeight >= _layoutViewHeight - 1);
            if (full)
            {
                VideoView.HorizontalAlignment = HorizontalAlignment.Stretch;
                VideoView.VerticalAlignment = VerticalAlignment.Stretch;
                VideoView.Margin = new Thickness(0);
                VideoView.Width = double.NaN;
                VideoView.Height = double.NaN;
            }
            else if (_layoutVisible)
            {
                var scaleX = _layoutViewWidth > 0 && viewWidth > 0 ? viewWidth / _layoutViewWidth : 1;
                var scaleY = _layoutViewHeight > 0 && viewHeight > 0 ? viewHeight / _layoutViewHeight : 1;
                var scaleText = Math.Round(scaleX, 3) + " x " + Math.Round(scaleY, 3);
                if (scaleText != _layoutScaleLogged)
                {
                    _layoutScaleLogged = scaleText;
                    Log.Write("Page is " + _layoutViewWidth + "x" + _layoutViewHeight + " in a " +
                        Math.Round(viewWidth) + "x" + Math.Round(viewHeight) + " view: video boxes scaled " + scaleText);
                }
                VideoView.HorizontalAlignment = HorizontalAlignment.Left;
                VideoView.VerticalAlignment = VerticalAlignment.Top;
                VideoView.Margin = new Thickness(_layoutX * scaleX, _layoutY * scaleY, 0, 0);
                VideoView.Width = _layoutWidth * scaleX;
                VideoView.Height = _layoutHeight * scaleY;
            }
            VideoView.Opacity = _videoVisible && _layoutVisible ? 1 : 0;
        }

        private void ReloadPage()
        {
            // A fresh page also recovers from a crashed browser process.
            Frame.Navigate(typeof(MainPage));
            Frame.BackStack.Clear();
        }

        private void EnsureWebViewFocus()
        {
            if (LoadErrorPanel.Visibility != Visibility.Collapsed || _dialogOpen)
            {
                return;
            }
            for (var element = FocusManager.GetFocusedElement() as DependencyObject; element != null; element = VisualTreeHelper.GetParent(element))
            {
                if (element == WebView)
                {
                    return;
                }
            }
            WebView.Focus(FocusState.Programmatic);
        }

        // Lets the user type into a text box in the page with the console's on-screen keyboard,
        // which reliably works with a XAML text box.
        async Task<TextEntryResult> IAppHost.RequestTextAsync(TextEntryRequest request)
        {
            if (_dialogOpen)
            {
                return null;
            }
            var isPassword = request.Kind == "password";
            var passwordBox = new PasswordBox { Password = isPassword ? request.Value ?? string.Empty : string.Empty };
            var textBox = new TextBox { Text = request.Value ?? string.Empty, IsSpellCheckEnabled = false };
            var scopeName = InputScopeFor(request.Kind);
            if (scopeName.HasValue)
            {
                var scope = new InputScope();
                scope.Names.Add(new InputScopeName(scopeName.Value));
                textBox.InputScope = scope;
            }
            Control input = isPassword ? (Control)passwordBox : textBox;

            var dialog = new ContentDialog
            {
                Title = string.IsNullOrWhiteSpace(request.Label) ? "Enter text" : request.Label,
                Content = input,
                PrimaryButtonText = "OK",
                CloseButtonText = "Cancel",
                DefaultButton = ContentDialogButton.Primary,
            };
            var submitted = false;
            // Accepting the on-screen keyboard sends Enter: treat that as OK.
            input.KeyDown += (s, e) =>
            {
                if (e.Key == VirtualKey.Enter)
                {
                    e.Handled = true;
                    submitted = true;
                    dialog.Hide();
                }
            };
            // Ask for the keyboard whenever the box gets focus, and again shortly after the dialog
            // opens: a password box isn't always ready for it straight away.
            input.GotFocus += (s, e) => ShowOnScreenKeyboard();
            dialog.Opened += async (s, e) =>
            {
                input.Focus(FocusState.Keyboard);
                textBox.SelectAll();
                await Task.Delay(TimeSpan.FromMilliseconds(200));
                if (input.FocusState == FocusState.Unfocused)
                {
                    input.Focus(FocusState.Keyboard);
                }
                ShowOnScreenKeyboard();
            };

            _dialogOpen = true;
            if (_controller != null)
            {
                _controller.Paused = true;
            }
            ContentDialogResult result;
            try
            {
                result = await dialog.ShowAsync();
            }
            finally
            {
                _dialogOpen = false;
                if (_controller != null)
                {
                    _controller.Paused = LoadErrorPanel.Visibility != Visibility.Collapsed;
                }
                WebView.Focus(FocusState.Programmatic);
            }
            if (result != ContentDialogResult.Primary && !submitted)
            {
                return null;
            }
            return new TextEntryResult(isPassword ? passwordBox.Password : textBox.Text, submitted);
        }

        private static InputScopeNameValue? InputScopeFor(string kind)
        {
            switch (kind)
            {
                case "email": return InputScopeNameValue.EmailSmtpAddress;
                case "url": return InputScopeNameValue.Url;
                case "search": return InputScopeNameValue.Search;
                case "number": return InputScopeNameValue.Number;
                default: return null;
            }
        }

        private static void ShowOnScreenKeyboard()
        {
            try
            {
                InputPane.GetForCurrentView().TryShow();
            }
            catch (Exception ex)
            {
                Log.Error("Showing the on-screen keyboard failed", ex);
            }
        }

        private void OnPreviewKeyDown(object sender, KeyRoutedEventArgs e)
        {
            // ControllerBridge handles the controller. Stop XAML from also using its buttons to move
            // focus out of the web page, except on the load error screen where they work its buttons.
            var key = (int)e.Key;
            var isController = (key >= (int)VirtualKey.GamepadA && key <= (int)VirtualKey.GamepadRightThumbstickLeft) ||
                (key >= (int)VirtualKey.NavigationView && key <= (int)VirtualKey.NavigationCancel);
            if (isController && LoadErrorPanel.Visibility == Visibility.Collapsed)
            {
                e.Handled = true;
                EnsureWebViewFocus();
            }
        }

        // Realizes the x:Load="False" VideoView. Done after the web app loads so that a problem in
        // VLC's video surface can't keep the app from starting.
        private void CreateVideoView()
        {
            if (_videoViewRequested)
            {
                return;
            }
            _videoViewRequested = true;
            try
            {
                Log.Write("Creating the VLC video surface");
                _videoViewStarting = true;
                FindName(nameof(VideoView));
                VideoView.Initialized += VideoView_Initialized;
                ApplyVideoLayout();
            }
            catch (Exception ex)
            {
                _videoViewStarting = false;
                Log.Error("Creating the VLC video surface failed", ex);
                _player.SetUnavailable("the video surface could not be created (" + ex.Message + ")");
            }
        }

        private void VideoView_Initialized(object sender, InitializedEventArgs e)
        {
            _videoViewStarting = false;
            Log.Write("VLC video surface ready");
            _player.Initialize(e.SwapChainOptions);
        }

        private void WebView_SizeChanged(object sender, SizeChangedEventArgs e)
        {
            ApplyVideoLayout();
        }

        private void VideoView_SizeChanged(object sender, SizeChangedEventArgs e)
        {
            _player.SetViewSize(e.NewSize.Width, e.NewSize.Height);
        }

        private void OnNavigationStarting(CoreWebView2 sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (IsWebApp(e.Uri))
            {
                _appNavigationId = e.NavigationId;
                return;
            }
            Log.Write("Opening outside the app: " + Log.DescribeUrl(e.Uri));
            e.Cancel = true;
            AppBridge.OpenExternal(e.Uri);
        }

        private void OnNavigationCompleted(CoreWebView2 sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (e.NavigationId != _appNavigationId)
            {
                return;
            }
            Log.Write("Web app load finished: " + (e.IsSuccess ? "success" : e.WebErrorStatus.ToString()));
            if (e.IsSuccess)
            {
                LoadErrorPanel.Visibility = Visibility.Collapsed;
                if (_controller != null)
                {
                    _controller.Paused = false;
                }
                EmulatePageFocus(sender);
                CreateVideoView();
            }
            else if (e.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled)
            {
                if (IsBundledWebApp && !_servingBundleManually)
                {
                    // The browser couldn't read the mapped folder; answer the requests from here.
                    Log.Write("Retrying the built-in web app without folder mapping");
                    ServeBundleManually(sender);
                    sender.Navigate(BundledUri.AbsoluteUri);
                    return;
                }
                ShowLoadError(IsBundledWebApp
                    ? "The built-in web app failed to load. (" + e.WebErrorStatus + ")"
                    : "Couldn't reach the web app at " + _appUri.Authority + ". (" + e.WebErrorStatus + ")", !IsBundledWebApp);
            }
        }

        // Without the console's mouse-mode cursor nothing ever clicks into the page, so the browser
        // treats it as unfocused (document.hasFocus() is false and text boxes ignore typing).
        private static async void EmulatePageFocus(CoreWebView2 core)
        {
            try
            {
                await core.CallDevToolsProtocolMethodAsync("Emulation.setFocusEmulationEnabled", "{\"enabled\":true}");
            }
            catch (Exception ex)
            {
                Log.Error("Page focus emulation failed", ex);
            }
        }

        private void OnNewWindowRequested(CoreWebView2 sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            if (IsWebApp(e.Uri))
            {
                sender.Navigate(e.Uri);
            }
            else
            {
                AppBridge.OpenExternal(e.Uri);
            }
        }

        private void OnProcessFailed(CoreWebView2 sender, CoreWebView2ProcessFailedEventArgs e)
        {
            Log.Write("WebView2 process failed: " + e.ProcessFailedKind);
            if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited ||
                e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
            {
                _player.Stop();
                sender.Reload();
            }
            else if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
            {
                ShowLoadError("The web view stopped unexpectedly.", false);
            }
        }

        private void OnBackRequested(object sender, BackRequestedEventArgs e)
        {
            // ControllerBridge already handles B; handling it here too would go back twice, and
            // leaving it unhandled would close the app.
            if (LoadErrorPanel.Visibility == Visibility.Collapsed)
            {
                e.Handled = true;
            }
        }

        private void OnWindowVisibilityChanged(object sender, VisibilityChangedEventArgs e)
        {
            _bridge?.SendVisibility(e.Visible);
        }

        private void RetryButton_Click(object sender, RoutedEventArgs e)
        {
            ReloadPage();
        }

        private void BuiltInButton_Click(object sender, RoutedEventArgs e)
        {
            SetWebAppUrl(null);
        }

        private void ShowLoadError(string message, bool offerBuiltIn)
        {
            LoadErrorText.Text = message;
            BuiltInButton.Visibility = offerBuiltIn ? Visibility.Visible : Visibility.Collapsed;
            LoadErrorPanel.Visibility = Visibility.Visible;
            if (_controller != null)
            {
                _controller.Paused = true;
            }
            RetryButton.Focus(FocusState.Programmatic);
        }

        private bool IsWebApp(string url)
        {
            Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri) || _appUri == null)
            {
                return false;
            }
            return uri.Scheme == _appUri.Scheme &&
                string.Equals(uri.Host, _appUri.Host, StringComparison.OrdinalIgnoreCase) &&
                uri.Port == _appUri.Port;
        }
    }
}
