package com.lumimuse.lumimuse

import android.Manifest
import android.content.ContentValues
import android.content.pm.PackageManager
import android.os.Build
import android.provider.MediaStore
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.FileInputStream

class MainActivity : FlutterActivity() {
    private val galleryChannel = "lumimuse/gallery_saver"
    private val writeStorageRequestCode = 4201

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            galleryChannel
        ).setMethodCallHandler { call, result ->
            if (call.method != "saveImageToGallery") {
                result.notImplemented()
                return@setMethodCallHandler
            }

            val path = call.argument<String>("path")
            if (path.isNullOrBlank()) {
                result.error("invalid_path", "图片路径为空", null)
                return@setMethodCallHandler
            }

            try {
                if (!ensureLegacyWritePermission()) {
                    result.error("permission_denied", "没有保存到相册的存储权限", null)
                    return@setMethodCallHandler
                }
                saveImageToGallery(path)
                result.success(null)
            } catch (error: Exception) {
                result.error("save_failed", error.message ?: "保存到相册失败", null)
            }
        }
    }

    private fun saveImageToGallery(path: String) {
        val source = File(path)
        if (!source.exists()) {
            throw IllegalArgumentException("图片文件不存在")
        }

        val extension = source.extension.lowercase().ifBlank { "png" }
        val mimeType = when (extension) {
            "jpg", "jpeg" -> "image/jpeg"
            "webp" -> "image/webp"
            else -> "image/png"
        }
        val displayName = "LumiMuse_${System.currentTimeMillis()}.$extension"
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, displayName)
            put(MediaStore.Images.Media.MIME_TYPE, mimeType)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/LumiMuse")
                put(MediaStore.Images.Media.IS_PENDING, 1)
            }
        }

        val resolver = applicationContext.contentResolver
        val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
            ?: throw IllegalStateException("无法创建相册文件")

        try {
            resolver.openOutputStream(uri)?.use { output ->
                FileInputStream(source).use { input ->
                    input.copyTo(output)
                }
            } ?: throw IllegalStateException("无法写入相册文件")

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                values.clear()
                values.put(MediaStore.Images.Media.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
            }
        } catch (error: Exception) {
            resolver.delete(uri, null, null)
            throw error
        }
    }

    private fun ensureLegacyWritePermission(): Boolean {
        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.P) return true
        val permission = Manifest.permission.WRITE_EXTERNAL_STORAGE
        if (ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED) {
            return true
        }
        ActivityCompat.requestPermissions(this, arrayOf(permission), writeStorageRequestCode)
        return false
    }
}
