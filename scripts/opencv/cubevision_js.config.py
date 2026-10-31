# CubeVision で使う OpenCV.js の関数とクラス（scripts/opencv/build.sh で、必要なものだけを SIMD 付きでビルドする）。
# 使っているのは ArUco の検出（src/aruco/detect.ts・codes.ts）と色の変換だけ。テストでマーカーの画像を作る generateImageMarker も入れる

core = {
    '': [],
    'Algorithm': [],
}

imgproc = {
    '': ['cvtColor'],
}

objdetect = {
    '': ['getPredefinedDictionary', 'generateImageMarker'],
    'aruco_PredefinedDictionaryType': [],
    'aruco_Dictionary': ['Dictionary', 'getDistanceToId', 'generateImageMarker', 'getByteListFromBits', 'getBitsFromByteList'],
    'aruco_DetectorParameters': ['DetectorParameters'],
    'aruco_RefineParameters': ['RefineParameters'],
    'aruco_ArucoDetector': ['ArucoDetector', 'detectMarkers', 'setDictionary', 'setDetectorParameters', 'setRefineParameters'],
}

white_list = makeWhiteList([core, imgproc, objdetect])
