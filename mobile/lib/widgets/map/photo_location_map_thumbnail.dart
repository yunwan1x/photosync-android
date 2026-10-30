import 'dart:math';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/asyncvalue_extensions.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/translate_extensions.dart';
import 'package:immich_mobile/presentation/widgets/map/map.state.dart';
import 'package:immich_mobile/utils/photo_map_viewport.dart';
import 'package:immich_mobile/widgets/map/map_thumbnail.dart';
import 'package:maplibre_gl/maplibre_gl.dart';

typedef PhotoMapThumbnailBuilder = Widget Function(PhotoMapViewport viewport);

class PhotoLocationMapThumbnail extends ConsumerWidget {
  final void Function(Point<double>, LatLng)? onTap;
  final bool showAttribution;
  final ThemeMode? themeMode;
  final PhotoMapThumbnailBuilder? thumbnailBuilder;

  const PhotoLocationMapThumbnail({
    super.key,
    this.onTap,
    this.showAttribution = false,
    this.themeMode,
    this.thumbnailBuilder,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final viewport = ref.watch(photoMapViewportProvider);
    return viewport.widgetWhen(
      onLoading: () => const Center(child: CircularProgressIndicator()),
      onError: (_, __) => const Center(child: Icon(Icons.map_outlined)),
      onData: (viewport) {
        return Stack(
          fit: StackFit.expand,
          children: [
            thumbnailBuilder?.call(viewport) ??
                MapThumbnail(
                  centre: viewport.center,
                  zoom: viewport.zoom,
                  bounds: viewport.bounds,
                  onTap: onTap,
                  showAttribution: showAttribution,
                  themeMode: themeMode,
                ),
            if (viewport.isEmpty)
              Center(
                child: DecoratedBox(
                  key: const Key('photo-location-empty-state'),
                  decoration: BoxDecoration(
                    color: context.colorScheme.surface.withValues(alpha: 0.86),
                    borderRadius: BorderRadius.circular(16),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                    child: Text('no_places'.t(context: context)),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}
