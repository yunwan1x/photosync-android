import 'dart:async';

/// Debounces noisy connectivity callbacks and coalesces endpoint selection so
/// only one probe can mutate the active endpoint at a time.
class NetworkEndpointSwitchCoordinator {
  NetworkEndpointSwitchCoordinator({required this.switchEndpoint, this.debounce = const Duration(milliseconds: 1500)});

  final Future<void> Function() switchEndpoint;
  final Duration debounce;

  Timer? _timer;
  Future<void>? _inFlight;
  bool _runAgain = false;
  bool _disposed = false;

  void schedule() {
    if (_disposed) {
      return;
    }
    _timer?.cancel();
    _timer = Timer(debounce, _run);
  }

  Future<void> _run() async {
    if (_disposed) {
      return;
    }
    if (_inFlight != null) {
      _runAgain = true;
      return;
    }

    final operation = switchEndpoint();
    _inFlight = operation;
    try {
      await operation;
    } finally {
      if (identical(_inFlight, operation)) {
        _inFlight = null;
      }
      if (_runAgain && !_disposed) {
        _runAgain = false;
        schedule();
      }
    }
  }

  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _timer = null;
  }
}
