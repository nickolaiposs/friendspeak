# Models

`selfie_segmenter.tflite` is MediaPipe's selfie segmentation model (float16),
used for camera backgrounds (`public/js/background.js`, D37). It is published
by Google under the Apache License 2.0:

- Source: <https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite>
- Docs and model card: <https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter>
- SHA-256: `191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b`

It ships inside the desktop app, so the effect works offline and nothing is
fetched from Google at run time.
