import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/services/network_endpoint_switch_coordinator.dart';

void main() {
  test('debounces repeated connectivity changes', () async {
    var calls = 0;
    final coordinator = NetworkEndpointSwitchCoordinator(
      debounce: const Duration(milliseconds: 20),
      switchEndpoint: () async => calls++,
    );
    addTearDown(coordinator.dispose);

    coordinator.schedule();
    await Future<void>.delayed(const Duration(milliseconds: 5));
    coordinator.schedule();
    await Future<void>.delayed(const Duration(milliseconds: 5));
    coordinator.schedule();
    await Future<void>.delayed(const Duration(milliseconds: 40));

    expect(calls, 1);
  });

  test('coalesces callbacks received while endpoint selection is running', () async {
    var calls = 0;
    final firstRun = Completer<void>();
    final coordinator = NetworkEndpointSwitchCoordinator(
      debounce: const Duration(milliseconds: 10),
      switchEndpoint: () {
        calls++;
        return calls == 1 ? firstRun.future : Future.value();
      },
    );
    addTearDown(coordinator.dispose);

    coordinator.schedule();
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(calls, 1);

    coordinator.schedule();
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(calls, 1);

    firstRun.complete();
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(calls, 2);
  });

  test('does not run scheduled work after disposal', () async {
    var calls = 0;
    final coordinator = NetworkEndpointSwitchCoordinator(
      debounce: const Duration(milliseconds: 10),
      switchEndpoint: () async => calls++,
    );

    coordinator.schedule();
    coordinator.dispose();
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(calls, 0);
  });
}
