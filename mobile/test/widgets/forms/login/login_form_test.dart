import 'package:drift/drift.dart' hide isNull;
import 'package:drift/native.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/locales.dart';
import 'package:immich_mobile/domain/services/store.service.dart';
import 'package:immich_mobile/generated/codegen_loader.g.dart';
import 'package:immich_mobile/infrastructure/repositories/db.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/store.repository.dart';
import 'package:immich_mobile/providers/server_info.provider.dart';
import 'package:immich_mobile/services/server_info.service.dart';
import 'package:immich_mobile/widgets/forms/login/login_form.dart';
import 'package:mocktail/mocktail.dart';

class _MockServerInfoService extends Mock implements ServerInfoService {}

void main() {
  late Drift database;

  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    database = Drift(DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
    await StoreService.init(storeRepository: DriftStoreRepository(database), listenUpdates: false);
  });

  tearDownAll(() async {
    await StoreService.I.dispose();
    await database.close();
  });

  testWidgets('server address input advertises DNS TXT endpoints', (tester) async {
    await tester.pumpWidget(
      EasyLocalization(
        supportedLocales: locales.values.toList(),
        path: translationsPath,
        startLocale: const Locale('en'),
        fallbackLocale: const Locale('en'),
        saveLocale: false,
        assetLoader: const CodegenLoader(),
        child: ProviderScope(
          overrides: [serverInfoProvider.overrideWith((ref) => ServerInfoNotifier(_MockServerInfoService()))],
          child: Builder(
            builder: (context) => MaterialApp(
              localizationsDelegates: context.localizationDelegates,
              supportedLocales: context.supportedLocales,
              locale: context.locale,
              home: Scaffold(body: LoginForm()),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    final endpointField = find.byType(TextFormField).first;
    final endpointDecorator = tester.widget<InputDecorator>(
      find.descendant(of: endpointField, matching: find.byType(InputDecorator)),
    );
    expect(endpointDecorator.decoration.hintText, contains('txt://'));
    expect(endpointDecorator.decoration.helperText, contains('txt://domain'));
    expect(endpointDecorator.decoration.helperMaxLines, 3);
    expect(tester.takeException(), isNull);
  });

  testWidgets('server address help remains visible on a narrow screen with large text', (tester) async {
    tester.view.physicalSize = const Size(320, 800);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);

    await tester.pumpWidget(
      EasyLocalization(
        supportedLocales: locales.values.toList(),
        path: translationsPath,
        startLocale: const Locale('zh', 'Hans'),
        fallbackLocale: const Locale('en'),
        saveLocale: false,
        assetLoader: const CodegenLoader(),
        child: ProviderScope(
          overrides: [serverInfoProvider.overrideWith((ref) => ServerInfoNotifier(_MockServerInfoService()))],
          child: Builder(
            builder: (context) => MaterialApp(
              localizationsDelegates: context.localizationDelegates,
              supportedLocales: context.supportedLocales,
              locale: context.locale,
              home: Scaffold(body: LoginForm()),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    final endpointField = find.byType(TextFormField).first;
    final endpointDecorator = tester.widget<InputDecorator>(
      find.descendant(of: endpointField, matching: find.byType(InputDecorator)),
    );
    expect(endpointDecorator.decoration.labelText, '服务器地址');
    expect(endpointDecorator.decoration.helperText, contains('txt://'));
    expect(endpointDecorator.decoration.helperMaxLines, 3);
    expect(tester.takeException(), isNull);
  });
}
