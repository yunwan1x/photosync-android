import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/services/availability_probe_policy.dart';

void main() {
  test('caches an offline result during the probe cooldown', () {
    final policy = AvailabilityProbePolicy(cooldown: const Duration(seconds: 30));
    final start = DateTime(2026, 7, 23, 12);

    policy.record(start, false);

    expect(policy.cachedResult(start.add(const Duration(seconds: 29))), isFalse);
    expect(policy.cachedResult(start.add(const Duration(seconds: 30))), isNull);
  });

  test('allows recovery to replace the previous offline result', () {
    final policy = AvailabilityProbePolicy(cooldown: const Duration(seconds: 30));
    final start = DateTime(2026, 7, 23, 12);
    policy.record(start, false);

    final recoveredAt = start.add(const Duration(seconds: 31));
    expect(policy.cachedResult(recoveredAt), isNull);
    policy.record(recoveredAt, true);

    expect(policy.cachedResult(recoveredAt.add(const Duration(seconds: 10))), isTrue);
  });
}
