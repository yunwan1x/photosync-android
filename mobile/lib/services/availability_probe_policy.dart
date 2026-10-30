class AvailabilityProbePolicy {
  AvailabilityProbePolicy({this.cooldown = const Duration(seconds: 30)});

  final Duration cooldown;
  DateTime? _lastProbeAt;
  bool? _lastResult;

  bool? cachedResult(DateTime now) {
    final lastProbeAt = _lastProbeAt;
    if (lastProbeAt == null || now.difference(lastProbeAt) >= cooldown) {
      return null;
    }
    return _lastResult;
  }

  void record(DateTime now, bool result) {
    _lastProbeAt = now;
    _lastResult = result;
  }
}
