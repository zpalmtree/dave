"""Reject background tracks and retry segmentation from the source subject's interior."""
import json
from itertools import zip_longest

import numpy as np
from scipy.ndimage import distance_transform_edt


class ReplacementAlignmentError(RuntimeError):
    pass


def source_overlap(source, replacement):
    selected = source > 127
    if not selected.any():
        return None
    return float(np.count_nonzero(selected & (replacement > 127)) / selected.sum())


def validate_alignment(source, replacement, width, height, frames):
    from video_edit import decoded_frames
    count = 0
    for index, (a, b) in enumerate(zip_longest(
            decoded_frames(source, 'gray', width * height, frames),
            decoded_frames(replacement, 'gray', width * height, frames))):
        if a is None or b is None:
            raise ReplacementAlignmentError('Replacement alignment masks have different timelines.')
        overlap = source_overlap(np.frombuffer(a, np.uint8), np.frombuffer(b, np.uint8))
        # Different species need not share a silhouette, but the selected object
        # must occupy the source subject's location. A surrounding blanket does not.
        if overlap is not None and overlap < 0.25:
            raise ReplacementAlignmentError(
                f'Replacement mask misses the source subject in frame {index} ({overlap:.0%} overlap).')
        count += 1
    if count != frames:
        raise ReplacementAlignmentError('Replacement alignment masks are shorter than the segment.')


def source_point_graph(clip, source_mask, box, width, height, frames, prefix):
    """One point-guided mask per real frame; never union a box-selected background."""
    from video_edit import decoded_frames, node, SAM_MODEL
    if not 1 <= frames <= 360:
        raise ValueError('Point recovery requires 1 to 360 real frames.')
    x, y, right, bottom = box
    if not (0 <= x < right <= width and 0 <= y < bottom <= height):
        raise ValueError('Invalid point recovery crop.')
    graph = {
        'source': node('LoadVideo', file=clip),
        'frames': node('GetVideoComponents', video=['source', 0]),
        'sam': node('CheckpointLoaderSimple', ckpt_name=SAM_MODEL),
    }
    images = []
    count = 0
    for index, data in enumerate(decoded_frames(source_mask, 'gray', width * height, frames)):
        selected = np.frombuffer(data, np.uint8).reshape(height, width) > 127
        support = np.zeros_like(selected)
        support[y:bottom, x:right] = True
        if np.any(selected & ~support):
            raise ReplacementAlignmentError('Source subject extends outside the recovery crop.')
        image = f'mask_image_{index}'
        if selected.any():
            # Padding makes frame-edge subjects use an interior point as well.
            distance = distance_transform_edt(np.pad(selected, 1))[1:-1, 1:-1]
            py, px = np.unravel_index(distance.argmax(), distance.shape)
            frame, detect = f'frame_{index}', f'detect_{index}'
            graph[frame] = node('ImageFromBatch', image=['frames', 0], batch_index=index, length=1)
            graph[detect] = node('SAM3_Detect', model=['sam', 0], image=[frame, 0],
                positive_coords=json.dumps([{'x': int(px), 'y': int(py)}]),
                threshold=0.5, refine_iterations=2, individual_masks=False)
            graph[image] = node('MaskToImage', mask=[detect, 0])
        else:
            graph[image] = node('EmptyImage', width=width, height=height, batch_size=1, color=0)
        images.append(image)
        count += 1
    if count != frames:
        raise ReplacementAlignmentError('Source point masks are shorter than the segment.')
    # A linear chain caches batches of 2, 3, ... N images (quadratic memory).
    # Pair adjacent batches so each level retains only N images, in source order.
    batch_index = 1
    while len(images) > 1:
        pairs = []
        for index in range(0, len(images), 2):
            if index + 1 == len(images):
                pairs.append(images[index])
                continue
            batch = f'batch_{batch_index}'
            graph[batch] = node('ImageBatch', image1=[images[index], 0], image2=[images[index + 1], 0])
            pairs.append(batch)
            batch_index += 1
        images = pairs
    graph['mask_video'] = node('CreateVideo', images=[images[0], 0], fps=24.0, bit_depth=8)
    graph['save_mask'] = node('SaveVideo', video=['mask_video', 0], filename_prefix=prefix,
                              format='auto', codec='auto')
    return graph
