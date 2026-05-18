import Flutter
import Photos
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  private let galleryChannelName = "lumimuse/gallery_saver"

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    let channel = FlutterMethodChannel(
      name: galleryChannelName,
      binaryMessenger: engineBridge.applicationRegistrar.messenger()
    )
    channel.setMethodCallHandler { [weak self] call, result in
      guard call.method == "saveImageToGallery" else {
        result(FlutterMethodNotImplemented)
        return
      }
      guard
        let args = call.arguments as? [String: Any],
        let path = args["path"] as? String,
        !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      else {
        result(FlutterError(code: "invalid_path", message: "图片路径为空", details: nil))
        return
      }
      self?.saveImageToGallery(path: path, result: result)
    }
  }

  private func saveImageToGallery(path: String, result: @escaping FlutterResult) {
    let permission = PHPhotoLibrary.authorizationStatus(for: .addOnly)
    if permission == .authorized || permission == .limited {
      performSave(path: path, result: result)
      return
    }
    PHPhotoLibrary.requestAuthorization(for: .addOnly) { [weak self] status in
      DispatchQueue.main.async {
        guard status == .authorized || status == .limited else {
          result(FlutterError(code: "permission_denied", message: "没有保存到相册的权限", details: nil))
          return
        }
        self?.performSave(path: path, result: result)
      }
    }
  }

  private func performSave(path: String, result: @escaping FlutterResult) {
    guard FileManager.default.fileExists(atPath: path) else {
      result(FlutterError(code: "not_found", message: "图片文件不存在", details: nil))
      return
    }

    PHPhotoLibrary.shared().performChanges({
      PHAssetChangeRequest.creationRequestForAssetFromImage(atFileURL: URL(fileURLWithPath: path))
    }) { success, error in
      DispatchQueue.main.async {
        if success {
          result(nil)
        } else {
          result(FlutterError(
            code: "save_failed",
            message: error?.localizedDescription ?? "保存到相册失败",
            details: nil
          ))
        }
      }
    }
  }
}
