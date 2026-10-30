import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/presentation/widgets/map/map.state.dart';
import 'package:immich_mobile/utils/photo_map_viewport.dart';
import 'package:immich_mobile/widgets/map/photo_location_map_thumbnail.dart';
import 'package:maplibre_gl/maplibre_gl.dart';

import '../../test_utils.dart';
import '../../widget_tester_extensions.dart';

void main() {
  setUpAll(TestUtils.init);

  testWidgets('shows an empty state over the world viewport when no photo has a location', (tester) async {
    PhotoMapViewport? renderedViewport;

    await tester.pumpConsumerWidget(
      SizedBox(
        width: 300,
        height: 200,
        child: PhotoLocationMapThumbnail(
          thumbnailBuilder: (viewport) {
            renderedViewport = viewport;
            return const ColoredBox(color: Colors.blue);
          },
        ),
      ),
      overrides: [photoMapViewportProvider.overrideWith((ref) => PhotoMapViewport.world)],
    );

    expect(renderedViewport, same(PhotoMapViewport.world));
    expect(find.byKey(const Key('photo-location-empty-state')), findsOneWidget);
  });

  testWidgets('passes the shared multi-photo bounds to the thumbnail', (tester) async {
    final viewport = PhotoMapViewport.fromLocations(const [LatLng(31.2304, 121.4737), LatLng(39.9042, 116.4074)]);
    PhotoMapViewport? renderedViewport;

    await tester.pumpConsumerWidget(
      SizedBox(
        width: 300,
        height: 200,
        child: PhotoLocationMapThumbnail(
          thumbnailBuilder: (value) {
            renderedViewport = value;
            return const ColoredBox(color: Colors.blue);
          },
        ),
      ),
      overrides: [photoMapViewportProvider.overrideWith((ref) => viewport)],
    );

    expect(renderedViewport, same(viewport));
    expect(renderedViewport?.bounds, viewport.bounds);
    expect(find.byKey(const Key('photo-location-empty-state')), findsNothing);
  });
}
