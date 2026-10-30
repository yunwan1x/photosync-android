import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/utils/photo_map_viewport.dart';
import 'package:maplibre_gl/maplibre_gl.dart';

void main() {
  group('PhotoMapViewport', () {
    test('uses a world view when there are no valid locations', () {
      final viewport = PhotoMapViewport.fromLocations(const []);

      expect(viewport.isEmpty, isTrue);
      expect(viewport.center, const LatLng(0, 0));
      expect(viewport.zoom, 0);
      expect(viewport.bounds, isNull);
    });

    test('centers a single photo at asset zoom', () {
      final viewport = PhotoMapViewport.fromLocations(const [LatLng(39.9042, 116.4074)]);

      expect(viewport.locationCount, 1);
      expect(viewport.center, const LatLng(39.9042, 116.4074));
      expect(viewport.zoom, 12);
      expect(viewport.bounds, isNull);
    });

    test('fits multiple locations', () {
      final viewport = PhotoMapViewport.fromLocations(const [LatLng(31.2304, 121.4737), LatLng(39.9042, 116.4074)]);

      expect(viewport.bounds?.southwest, const LatLng(31.2304, 116.4074));
      expect(viewport.bounds?.northeast, const LatLng(39.9042, 121.4737));
    });

    test('uses the short arc across the international date line', () {
      final viewport = PhotoMapViewport.fromLocations(const [LatLng(10, 179), LatLng(12, -179)]);

      expect(viewport.bounds?.southwest.longitude, 179);
      expect(viewport.bounds?.northeast.longitude, -179);
      expect(viewport.center.longitude.abs(), 180);
    });

    test('ignores invalid and duplicate coordinates', () {
      final viewport = PhotoMapViewport.fromLocations(const [
        LatLng(39.9042, 116.4074),
        LatLng(39.9042, 116.4074),
        LatLng(double.nan, 0),
      ]);

      expect(viewport.locationCount, 1);
      expect(viewport.center, const LatLng(39.9042, 116.4074));
    });
  });
}
