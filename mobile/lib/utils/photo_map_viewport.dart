import 'package:maplibre_gl/maplibre_gl.dart';

class PhotoMapViewport {
  static const world = PhotoMapViewport(center: LatLng(0, 0), zoom: 0, locationCount: 0);

  final LatLng center;
  final double zoom;
  final LatLngBounds? bounds;
  final int locationCount;

  const PhotoMapViewport({required this.center, required this.zoom, required this.locationCount, this.bounds});

  bool get isEmpty => locationCount == 0;
  bool get hasBounds => bounds != null;

  static PhotoMapViewport fromLocations(Iterable<LatLng> locations) {
    final unique = <(double, double)>{};
    for (final location in locations) {
      if (!location.latitude.isFinite ||
          !location.longitude.isFinite ||
          location.latitude < -90 ||
          location.latitude > 90 ||
          location.longitude < -180 ||
          location.longitude > 180) {
        continue;
      }
      unique.add((location.latitude, location.longitude));
    }

    if (unique.isEmpty) {
      return world;
    }

    final points = unique.map((point) => LatLng(point.$1, point.$2)).toList(growable: false);
    if (points.length == 1) {
      return PhotoMapViewport(center: points.single, zoom: 12, locationCount: 1);
    }

    var south = points.first.latitude;
    var north = points.first.latitude;
    final longitudes = <double>[];
    for (final point in points) {
      south = point.latitude < south ? point.latitude : south;
      north = point.latitude > north ? point.latitude : north;
      longitudes.add(_normalize360(point.longitude));
    }
    longitudes.sort();

    var largestGap = -1.0;
    var largestGapIndex = 0;
    for (var index = 0; index < longitudes.length; index++) {
      final next = index == longitudes.length - 1 ? longitudes.first + 360 : longitudes[index + 1];
      final gap = next - longitudes[index];
      if (gap > largestGap) {
        largestGap = gap;
        largestGapIndex = index;
      }
    }

    final west360 = longitudes[(largestGapIndex + 1) % longitudes.length];
    final east360 = longitudes[largestGapIndex];
    final longitudeSpan = 360 - largestGap;
    final centerLongitude = _normalize180(west360 + longitudeSpan / 2);
    final west = _normalize180(west360);
    final east = _normalize180(east360);
    final center = LatLng((south + north) / 2, centerLongitude);

    if ((north - south).abs() < 1e-9 && longitudeSpan.abs() < 1e-9) {
      return PhotoMapViewport(center: center, zoom: 12, locationCount: points.length);
    }

    return PhotoMapViewport(
      center: center,
      zoom: 0,
      bounds: LatLngBounds(southwest: LatLng(south, west), northeast: LatLng(north, east)),
      locationCount: points.length,
    );
  }

  static double _normalize360(double longitude) => (longitude % 360 + 360) % 360;

  static double _normalize180(double longitude) {
    final normalized = _normalize360(longitude);
    return normalized > 180 ? normalized - 360 : normalized;
  }
}
