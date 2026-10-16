using System;
using Windows.Gaming.Input;
using Windows.UI.Xaml;

namespace Iptv.Input
{
    /// <summary>
    /// Reads the controller and hands the web app named actions ("up", "select", "back", ...).
    /// Inside WebView2 on Xbox the page never sees the A or B buttons, so the app reads them here
    /// and the page turns them into the TV remote's keys (web/js/platform/native.js).
    /// </summary>
    internal sealed class ControllerBridge : IDisposable
    {
        private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(30);
        private static readonly TimeSpan FirstRepeatDelay = TimeSpan.FromMilliseconds(400);
        private static readonly TimeSpan RepeatInterval = TimeSpan.FromMilliseconds(110);
        // A stick counts as pushed past StickPress, and as let go only once it is back inside
        // StickRelease: a stick hovering around one threshold would otherwise press over and over.
        private const double StickPress = 0.6;
        private const double StickRelease = 0.3;
        // A stick that is let go springs back past the middle; a push the other way this soon after
        // a release is that bounce, not a press.
        private static readonly TimeSpan StickBounce = TimeSpan.FromMilliseconds(200);
        private const double TriggerThreshold = 0.5;

        private static readonly ButtonAction[] Buttons =
        {
            new ButtonAction(GamepadButtons.A, "select"),
            new ButtonAction(GamepadButtons.B, "back"),
            new ButtonAction(GamepadButtons.X, "x"),
            new ButtonAction(GamepadButtons.Y, "y"),
            new ButtonAction(GamepadButtons.Menu, "menu"),
            new ButtonAction(GamepadButtons.View, "view"),
            new ButtonAction(GamepadButtons.LeftShoulder, "lb"),
            new ButtonAction(GamepadButtons.RightShoulder, "rb"),
        };

        private readonly Action<string, bool> _send;
        private readonly DispatcherTimer _timer = new DispatcherTimer();
        private GamepadButtons _previousButtons;
        private bool _previousLeftTrigger;
        private bool _previousRightTrigger;
        private string _heldDirection;
        private DateTime _nextRepeat;
        private string _stickDirection;
        private string _stickReleasedDirection;
        private DateTime _stickReleasedAt = DateTime.MinValue;

        /// <param name="send">Called on the UI thread with an action name and whether it is a held-down repeat.</param>
        public ControllerBridge(Action<string, bool> send)
        {
            _send = send;
            // Buttons already down at start (e.g. the A press that launched the app) don't count.
            var reading = Read();
            _previousButtons = reading.Buttons;
            _previousLeftTrigger = reading.LeftTrigger;
            _previousRightTrigger = reading.RightTrigger;
            _timer.Interval = PollInterval;
            _timer.Tick += OnTick;
            _timer.Start();
        }

        /// <summary>While true the controller is left to XAML, e.g. for a dialog or the load error screen.</summary>
        public bool Paused { get; set; }

        public void Dispose()
        {
            _timer.Stop();
        }

        private void OnTick(object sender, object e)
        {
            var reading = Read();
            var pressed = reading.Buttons & ~_previousButtons;
            var leftTriggerPressed = reading.LeftTrigger && !_previousLeftTrigger;
            var rightTriggerPressed = reading.RightTrigger && !_previousRightTrigger;
            _previousButtons = reading.Buttons;
            _previousLeftTrigger = reading.LeftTrigger;
            _previousRightTrigger = reading.RightTrigger;
            var now = DateTime.UtcNow;
            var stickDirection = ReadStick(reading.StickX, reading.StickY, now);
            if (Paused)
            {
                _heldDirection = null;
                return;
            }

            var direction = reading.DPadDirection ?? stickDirection;
            if (direction != _heldDirection)
            {
                _heldDirection = direction;
                if (direction != null)
                {
                    _send(direction, false);
                    _nextRepeat = now + FirstRepeatDelay;
                }
            }
            else if (direction != null && now >= _nextRepeat)
            {
                _send(direction, true);
                _nextRepeat = now + RepeatInterval;
            }

            foreach (var button in Buttons)
            {
                if ((pressed & button.Button) != 0)
                {
                    _send(button.Name, false);
                }
            }
            if (leftTriggerPressed)
            {
                _send("lt", false);
            }
            if (rightTriggerPressed)
            {
                _send("rt", false);
            }
        }

        // The direction the sticks point, with a gap between pressing and letting go and the
        // spring-back after a release ignored, so one flick is one move.
        private string ReadStick(double x, double y, DateTime now)
        {
            var size = Math.Max(Math.Abs(x), Math.Abs(y));
            if (_stickDirection != null)
            {
                if (size >= StickRelease)
                {
                    return _stickDirection;
                }
                _stickReleasedDirection = _stickDirection;
                _stickReleasedAt = now;
                _stickDirection = null;
                return null;
            }
            if (size < StickPress)
            {
                return null;
            }
            var direction = Math.Abs(y) >= Math.Abs(x) ? (y > 0 ? "up" : "down") : (x > 0 ? "right" : "left");
            if (now - _stickReleasedAt < StickBounce && direction == Opposite(_stickReleasedDirection))
            {
                return null;
            }
            _stickDirection = direction;
            return direction;
        }

        private static string Opposite(string direction)
        {
            switch (direction)
            {
                case "up": return "down";
                case "down": return "up";
                case "left": return "right";
                case "right": return "left";
                default: return null;
            }
        }

        private static ControllerReading Read()
        {
            var result = new ControllerReading();
            foreach (var gamepad in Gamepad.Gamepads)
            {
                var reading = gamepad.GetCurrentReading();
                result.Buttons |= reading.Buttons;
                result.LeftTrigger |= reading.LeftTrigger > TriggerThreshold;
                result.RightTrigger |= reading.RightTrigger > TriggerThreshold;
                if (result.DPadDirection == null)
                {
                    result.DPadDirection = GetDPadDirection(reading.Buttons);
                }
                // Either stick moves the highlight; the one pushed furthest wins.
                Stronger(ref result, reading.LeftThumbstickX, reading.LeftThumbstickY);
                Stronger(ref result, reading.RightThumbstickX, reading.RightThumbstickY);
            }
            return result;
        }

        private static void Stronger(ref ControllerReading result, double x, double y)
        {
            if (Math.Max(Math.Abs(x), Math.Abs(y)) > Math.Max(Math.Abs(result.StickX), Math.Abs(result.StickY)))
            {
                result.StickX = x;
                result.StickY = y;
            }
        }

        private static string GetDPadDirection(GamepadButtons buttons)
        {
            if ((buttons & GamepadButtons.DPadUp) != 0) return "up";
            if ((buttons & GamepadButtons.DPadDown) != 0) return "down";
            if ((buttons & GamepadButtons.DPadLeft) != 0) return "left";
            if ((buttons & GamepadButtons.DPadRight) != 0) return "right";
            return null;
        }

        private struct ControllerReading
        {
            public GamepadButtons Buttons;
            public bool LeftTrigger;
            public bool RightTrigger;
            public string DPadDirection;
            public double StickX;
            public double StickY;
        }

        private struct ButtonAction
        {
            public ButtonAction(GamepadButtons button, string name)
            {
                Button = button;
                Name = name;
            }

            public GamepadButtons Button;
            public string Name;
        }
    }
}
