package com.folio.executorchengine

import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Debug
import android.os.SystemClock
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.pytorch.executorch.extension.llm.LlmCallback
import org.pytorch.executorch.extension.llm.LlmGenerationConfig
import org.pytorch.executorch.extension.llm.LlmModule
import org.pytorch.executorch.extension.llm.LlmModuleConfig

class FolioExecuTorchEngineModule : Module() {
  private enum class PromptTemplate(val value: String) {
    PLAIN("plain"),
    CHATML("chatml"),
    GEMMA4_CHAT("gemma4-chat"),
  }

  private data class SessionRuntimeOptions(
    val supportsVision: Boolean,
    val promptTemplate: PromptTemplate,
    val temperature: Float,
    val maxNewTokens: Int,
    val maxSeqLen: Int?,
  ) {
    companion object {
      fun fromMap(map: Map<String, Any?>): SessionRuntimeOptions =
        SessionRuntimeOptions(
          supportsVision = map["supportsVision"] as? Boolean ?: false,
          promptTemplate =
            PromptTemplate.entries.firstOrNull { it.value == map["promptTemplate"] as? String }
              ?: PromptTemplate.PLAIN,
          temperature = (map["temperature"] as? Number)?.toFloat() ?: 0.8f,
          maxNewTokens = (map["maxNewTokens"] as? Number)?.toInt() ?: 256,
          maxSeqLen = (map["maxSeqLen"] as? Number)?.toInt(),
        )
    }
  }

  private data class ChatAttachmentPayload(
    val id: String,
    val type: String,
    val localUri: String,
  ) {
    companion object {
      fun fromMap(map: Map<String, Any?>): ChatAttachmentPayload =
        ChatAttachmentPayload(
          id = map["id"] as? String ?: throw IllegalArgumentException("Attachment payload is missing id."),
          type = map["type"] as? String ?: throw IllegalArgumentException("Attachment payload is missing type."),
          localUri =
            map["localUri"] as? String
              ?: throw IllegalArgumentException("Attachment payload is missing localUri."),
        )
    }
  }

  private data class ImageTensor(
    val values: FloatArray,
    val width: Int,
    val height: Int,
    val channels: Int,
  )

  private class SessionState(
    val artifactId: String,
    val backendId: String,
    val module: LlmModule,
    val runtimeOptions: SessionRuntimeOptions,
    val maxSequenceLength: Int,
  ) {
    val isGenerating = AtomicBoolean(false)
    val wasInterrupted = AtomicBoolean(false)
    val turnIndex = AtomicInteger(0)
    var isSuspended = false
  }

  private data class ArtifactRuntimeManifest(
    val modelFile: String?,
    val tokenizerFile: String?,
    val maxSequenceLength: Int,
  )

  private val sessions = ConcurrentHashMap<String, SessionState>()
  private val gemmaVisionTargetSize = 896

  @Volatile
  private var telemetrySnapshot: Map<String, Any> =
    buildTelemetrySnapshot(
      ttftMs = 0,
      decodeTokensPerSecond = 0.0,
      peakMemoryMb = currentMemoryMb(),
      queueDepth = 0,
      lastRoute = "xnnpack",
    )

  override fun definition() = ModuleDefinition {
    Name("FolioExecuTorchEngine")
    Events("onGenerationChunk", "onAppLifecycle")

    OnCreate {
      ProcessLifecycleOwner.get().lifecycle.addObserver(appLifecycleObserver)
    }

    OnDestroy {
      ProcessLifecycleOwner.get().lifecycle.removeObserver(appLifecycleObserver)
      sessions.values.forEach { session ->
        withContext(Dispatchers.IO) {
          session.module.stop()
          session.module.resetContext()
          session.module.resetNative()
        }
      }
      sessions.clear()
    }

    Function("getRuntimeInfo") {
      mapOf(
        "runtime" to "executorch",
        "platform" to "android",
        "buildTarget" to "expo-dev-client",
        "devClient" to true,
        "newArchitecture" to true,
        "moduleVersion" to "0.5.0",
      )
    }

    Function("getAvailableBackends") {
      listOf(
        mapOf(
          "id" to "xnnpack",
          "available" to true,
          "source" to "native",
          "reason" to "XNNPACK is linked through the Android ExecuTorch runtime.",
        ),
        mapOf(
          "id" to "coreml",
          "available" to false,
          "source" to "native",
          "reason" to "CoreML is only available on iOS.",
        ),
        mapOf(
          "id" to "vulkan",
          "available" to hasVulkanSupport(),
          "source" to "native",
          "reason" to if (hasVulkanSupport()) {
            "Vulkan is available on this Android device and linked in the runtime."
          } else {
            "Vulkan is only available on Android devices that expose Vulkan hardware support."
          },
        ),
        mapOf(
          "id" to "mediatek",
          "available" to false,
          "source" to "native",
          "reason" to "The MediaTek backend is not linked in this Android build.",
        ),
      )
    }

    AsyncFunction("prepareArtifactAsync") { _: String, _: String, _: String, _: String ->
      @Suppress("UNREACHABLE_CODE")
      throw IllegalStateException("Artifact preparation is managed by the shared React Native runtime on Android.")
      false
    }

    AsyncFunction("createSessionAsync") Coroutine {
      artifactId: String,
      backendId: String,
      localUri: String,
      runtimeOptionsMap: Map<String, Any?>,
      ->
      if (backendId == "mediatek") {
        throw IllegalArgumentException("The MediaTek backend is not linked in this Android build.")
      }

      val artifactDirectory = resolveArtifactDirectory(localUri)
      val manifest = loadArtifactManifest(artifactDirectory)
      val modelFile =
        resolveRunnableFile(
          root = artifactDirectory,
          relativePath = manifest.modelFile,
          predicate = { it.extension.lowercase(Locale.US) == "pte" },
          missingMessage = "Artifact does not contain a runnable .pte file.",
        )
      val tokenizerFile =
        resolveRunnableFile(
          root = artifactDirectory,
          relativePath = manifest.tokenizerFile,
          predicate = ::isTokenizerFile,
          missingMessage = "Artifact does not contain a supported tokenizer file.",
        )
      val runtimeOptions = SessionRuntimeOptions.fromMap(runtimeOptionsMap)
      val modelType =
        if (runtimeOptions.supportsVision) {
          LlmModuleConfig.MODEL_TYPE_TEXT_VISION
        } else {
          LlmModuleConfig.MODEL_TYPE_TEXT
        }

      val moduleConfig =
        LlmModuleConfig.create()
          .modulePath(modelFile.absolutePath)
          .tokenizerPath(tokenizerFile.absolutePath)
          .modelType(modelType)
          .temperature(runtimeOptions.temperature)
          .build()
      val llmModule = withContext(Dispatchers.IO) { LlmModule(moduleConfig) }
      val loadStatus = withContext(Dispatchers.IO) { llmModule.load() }
      if (loadStatus != 0) {
        llmModule.resetNative()
        throw IllegalStateException("ExecuTorch failed to load the model (status=$loadStatus).")
      }

      val resolvedMaxSeqLen = runtimeOptions.maxSeqLen ?: manifest.maxSequenceLength
      val sessionId = "android-${System.currentTimeMillis()}"
      sessions[sessionId] =
        SessionState(
          artifactId = artifactId,
          backendId = backendId,
          module = llmModule,
          runtimeOptions = runtimeOptions,
          maxSequenceLength = resolvedMaxSeqLen,
        )
      telemetrySnapshot =
        buildTelemetrySnapshot(
          ttftMs = 0,
          decodeTokensPerSecond = 0.0,
          peakMemoryMb = currentMemoryMb(),
          queueDepth = sessions.size,
          lastRoute = backendId,
        )

      mapOf(
        "sessionId" to sessionId,
        "artifactId" to artifactId,
        "backendId" to backendId,
        "status" to "ready",
      )
    }

    AsyncFunction("generateChatReplyAsync") Coroutine {
      sessionId: String,
      prompt: String,
      _: String,
      attachmentMaps: List<Map<String, Any?>>,
      historyMaps: List<Map<String, Any>>,
      ->
      val session =
        sessions[sessionId]
          ?: return@Coroutine mapOf(
            "sessionId" to sessionId,
            "backendId" to "xnnpack",
            "text" to "This session is no longer active. Create a new runtime session before sending another message.",
            "tokensGenerated" to 0,
            "turnIndex" to 0,
            "finishReason" to "blocked",
            "telemetry" to telemetrySnapshot,
          )
      if (!session.isGenerating.compareAndSet(false, true)) {
        return@Coroutine mapOf(
          "sessionId" to sessionId,
          "backendId" to session.backendId,
          "text" to "Folio is still finishing the previous reply. Wait a moment before sending another message.",
          "tokensGenerated" to 0,
          "turnIndex" to session.turnIndex.get(),
          "finishReason" to "blocked",
          "telemetry" to telemetrySnapshot,
        )
      }

      try {
        session.wasInterrupted.set(false)
        val attachments = attachmentMaps.map(ChatAttachmentPayload::fromMap)
        val currentTurnIndex = session.turnIndex.get()
        val stopTokens = outputStopTokens(session.runtimeOptions.promptTemplate)
        val startedAt = SystemClock.elapsedRealtimeNanos()
        val firstTokenAt = AtomicLong(0L)
        val tokenCount = AtomicInteger(0)
        val outputBuffer = StringBuilder()
        val statsHolder = arrayOfNulls<JSONObject>(1)
        val hitStopToken = AtomicBoolean(false)

        val callback =
          object : LlmCallback {
            override fun onResult(result: String) {
              if (hitStopToken.get()) return
              firstTokenAt.compareAndSet(0L, SystemClock.elapsedRealtimeNanos())
              if (result in stopTokens) {
                hitStopToken.set(true)
                session.module.stop()
                return
              }
              val emittedTokenCount = tokenCount.incrementAndGet()
              outputBuffer.append(result)
              sendEvent(
                "onGenerationChunk",
                mapOf(
                  "sessionId" to sessionId,
                  "chunkText" to result,
                  "accumulatedText" to outputBuffer.toString(),
                  "tokensGenerated" to emittedTokenCount,
                ),
              )
            }

            override fun onStats(stats: String) {
              statsHolder[0] =
                try {
                  JSONObject(stats)
                } catch (_: Exception) {
                  null
                }
            }
          }

        val generationConfig =
          LlmGenerationConfig.create()
            .echo(false)
            .seqLen(session.maxSequenceLength)
            .temperature(session.runtimeOptions.temperature)
            .maxNewTokens(session.runtimeOptions.maxNewTokens)
            .build()

        val status =
          withContext(Dispatchers.IO) {
            val renderedPrompt = prepareInputsForGeneration(session, prompt, attachments, historyMaps, currentTurnIndex)
            session.module.generate(renderedPrompt, generationConfig, callback)
          }
        val finishedAt = SystemClock.elapsedRealtimeNanos()
        val wasInterrupted = session.wasInterrupted.getAndSet(false)

        if (status != 0 && !wasInterrupted && !hitStopToken.get()) {
          throw IllegalStateException("ExecuTorch generation failed with status=$status.")
        }

        val rawOutput = outputBuffer.toString()
        val outputText = stripOutputSpecialTokens(rawOutput, session.runtimeOptions.promptTemplate)
        val stats = statsHolder[0]
        val tokensGenerated =
          stats?.optInt("generated_tokens")?.takeIf { it > 0 }
            ?: tokenCount.get().takeIf { it > 0 }
            ?: estimateTokenCount(outputText)
        val ttftMs =
          durationMs(
            startedAt,
            firstTokenAt.get().takeIf { it > 0 } ?: finishedAt,
          )
        val decodeTokensPerSecond =
          stats?.optDouble("decode_token_per_sec")?.takeIf { !it.isNaN() && it >= 0 }
            ?: fallbackDecodeTokensPerSecond(tokensGenerated, firstTokenAt.get(), finishedAt)

        val turnIndex = if (wasInterrupted) {
          session.turnIndex.set(0)
          0
        } else {
          session.turnIndex.incrementAndGet()
        }
        telemetrySnapshot =
          buildTelemetrySnapshot(
            ttftMs = ttftMs,
            decodeTokensPerSecond = decodeTokensPerSecond,
            peakMemoryMb = currentMemoryMb(),
            queueDepth = sessions.size,
            lastRoute = session.backendId,
          )

        mapOf(
          "sessionId" to sessionId,
          "backendId" to session.backendId,
          "text" to outputText,
          "tokensGenerated" to tokensGenerated,
          "turnIndex" to turnIndex,
          "finishReason" to if (wasInterrupted) "interrupted" else "completed",
          "telemetry" to telemetrySnapshot,
        )
      } finally {
        session.isGenerating.set(false)
      }
    }

    AsyncFunction("interruptGenerationAsync") Coroutine { sessionId: String ->
      val session = sessions[sessionId] ?: return@Coroutine false
      session.wasInterrupted.set(true)
      withContext(Dispatchers.IO) {
        session.module.stop()
        session.module.resetContext()
      }
      true
    }

    AsyncFunction("resetSessionContextAsync") Coroutine { sessionId: String ->
      val session = sessions[sessionId] ?: return@Coroutine false
      withContext(Dispatchers.IO) {
        session.module.stop()
        session.module.resetContext()
      }
      session.turnIndex.set(0)
      session.isGenerating.set(false)
      session.wasInterrupted.set(false)
      telemetrySnapshot =
        buildTelemetrySnapshot(
          ttftMs = 0,
          decodeTokensPerSecond = 0.0,
          peakMemoryMb = currentMemoryMb(),
          queueDepth = sessions.size,
          lastRoute = session.backendId,
        )
      true
    }

    AsyncFunction("cancelSessionAsync") Coroutine { sessionId: String ->
      sessions.remove(sessionId)?.let { session ->
        withContext(Dispatchers.IO) {
          session.module.stop()
          session.module.resetContext()
          session.module.resetNative()
        }
      }
      telemetrySnapshot = telemetrySnapshot + ("queueDepth" to sessions.size)
      true
    }

    AsyncFunction("getTelemetrySnapshotAsync") {
      telemetrySnapshot
    }

    Function("isSessionActive") { sessionId: String ->
      val session = sessions[sessionId] ?: return@Function false
      !session.isSuspended
    }

    AsyncFunction("suspendAllSessionsAsync") Coroutine {
      sessions.values.forEach { session ->
        if (!session.isGenerating.get()) {
          withContext(Dispatchers.IO) {
            session.module.stop()
            session.module.resetContext()
          }
          session.isSuspended = true
        }
      }
      true
    }

    AsyncFunction("resumeSessionAsync") Coroutine { sessionId: String ->
      val session = sessions[sessionId] ?: return@Coroutine mapOf(
        "sessionId" to sessionId,
        "artifactId" to "",
        "backendId" to "xnnpack",
        "status" to "not_found",
      )

      if (!session.isSuspended) {
        return@Coroutine mapOf(
          "sessionId" to sessionId,
          "artifactId" to session.artifactId,
          "backendId" to session.backendId,
          "status" to "ready",
        )
      }

      session.isSuspended = false
      telemetrySnapshot =
        buildTelemetrySnapshot(
          ttftMs = 0,
          decodeTokensPerSecond = 0.0,
          peakMemoryMb = currentMemoryMb(),
          queueDepth = sessions.size,
          lastRoute = session.backendId,
        )
      mapOf(
        "sessionId" to sessionId,
        "artifactId" to session.artifactId,
        "backendId" to session.backendId,
        "status" to "ready",
      )
    }
  }

  private fun hasVulkanSupport(): Boolean {
    val packageManager = appContext.reactContext?.packageManager ?: return false
    return packageManager.hasSystemFeature(PackageManager.FEATURE_VULKAN_HARDWARE_LEVEL)
  }

  private fun resolveArtifactDirectory(localUri: String): File {
    val path =
      if (localUri.startsWith("file://")) {
        Uri.parse(localUri).path
      } else {
        localUri
      } ?: throw IllegalArgumentException("Artifact directory is not a valid file URI.")
    if (path.contains("..")) {
      throw IllegalArgumentException("Artifact directory path contains invalid traversal sequence.")
    }
    val artifactDirectory = File(path)
    if (!artifactDirectory.exists() || !artifactDirectory.isDirectory) {
      throw IllegalArgumentException("Artifact directory does not exist: ${artifactDirectory.canonicalPath}")
    }
    return artifactDirectory
  }

  private fun loadArtifactManifest(root: File): ArtifactRuntimeManifest {
    val runtimeManifestFile = File(root, "folio-runtime-manifest.json")
    if (runtimeManifestFile.exists()) {
      val runtimeJson = JSONObject(runtimeManifestFile.readText())
      return ArtifactRuntimeManifest(
        modelFile = runtimeJson.optString("model_file").ifEmpty { null },
        tokenizerFile = runtimeJson.optString("tokenizer_file").ifEmpty { null },
        maxSequenceLength = runtimeJson.optString("max_seq_len").toIntOrNull()?.takeIf { it > 0 } ?: 2048,
      )
    }

    val manifestFile = File(root, "folio-export-manifest.json")
    if (!manifestFile.exists()) {
      return ArtifactRuntimeManifest(modelFile = null, tokenizerFile = null, maxSequenceLength = 2048)
    }
    val json = JSONObject(manifestFile.readText())
    return ArtifactRuntimeManifest(
      modelFile = json.optString("model_file").ifEmpty { null },
      tokenizerFile = json.optString("tokenizer_file").ifEmpty { null },
      maxSequenceLength = json.optString("max_seq_len").toIntOrNull()?.takeIf { it > 0 } ?: 2048,
    )
  }

  private fun resolveRunnableFile(
    root: File,
    relativePath: String?,
    predicate: (File) -> Boolean,
    missingMessage: String,
  ): File {
    if (!relativePath.isNullOrBlank()) {
      val candidate = File(root, relativePath).canonicalFile
      val rootCanonical = root.canonicalPath
      if (!candidate.canonicalPath.startsWith(rootCanonical) || candidate.canonicalPath.contains("..")) {
        throw IllegalArgumentException(missingMessage)
      }
      if (candidate.exists() && predicate(candidate)) {
        return candidate
      }
      throw IllegalArgumentException(missingMessage)
    }

    root.walkTopDown().forEach { candidate ->
      if (candidate.isFile && predicate(candidate)) {
        return candidate
      }
    }

    throw IllegalArgumentException(missingMessage)
  }

  private fun isTokenizerFile(file: File): Boolean {
    val name = file.name.lowercase(Locale.US)
    return name == "tokenizer.json" ||
      name == "tokenizer.model" ||
      name.startsWith("tokenizer.model.") ||
      name == "tokenizer.bin" ||
      name == "tokenizer_config.json" ||
      name.endsWith(".tiktoken") ||
      name.endsWith(".spm") ||
      name == "spiece.model" ||
      name == "sentencepiece.bpe.model"
  }

  private fun prepareInputsForGeneration(
    session: SessionState,
    prompt: String,
    attachments: List<ChatAttachmentPayload>,
    historyMaps: List<Map<String, Any>>,
    turnIndex: Int,
  ): String {
    val useHistory = historyMaps.isNotEmpty()
    val supportsVision = session.runtimeOptions.supportsVision && attachments.isNotEmpty()

    if (!useHistory && !supportsVision) {
      return renderTextPrompt(prompt, session.runtimeOptions.promptTemplate, turnIndex)
    }

    if (useHistory && !supportsVision) {
      return renderConversationalPrompt(historyMaps, prompt, session.runtimeOptions.promptTemplate, turnIndex)
    }

    // Multimodal with history: render history into the text prompt
    return when (session.runtimeOptions.promptTemplate) {
      PromptTemplate.GEMMA4_CHAT -> {
        val prefix = if (turnIndex == 0) "<bos><|turn>user\n" else "<|turn>user\n"
        session.module.prefillPrompt(prefix)
        attachments.forEach { attachment ->
          session.module.prefillPrompt("<|image|>")
          val imageTensor = loadNormalizedImage(attachment)
          session.module.prefillImages(
            imageTensor.values,
            imageTensor.width,
            imageTensor.height,
            imageTensor.channels,
          )
        }
        val historyPrompt = if (useHistory) {
          val hist = historyMaps.mapNotNull { it["role"] as? String to (it["content"] as? String) }.filter { it.second != null }
          if (hist.isEmpty()) null else renderConversationalPrompt(historyMaps, prompt, session.runtimeOptions.promptTemplate, turnIndex)
        } else null
        val textPart = historyPrompt ?: prompt
        "${textPart}<turn|>\n<|turn>model\n"
      }

      PromptTemplate.PLAIN, PromptTemplate.CHATML -> {
        attachments.forEach { attachment ->
          val imageTensor = loadNormalizedImage(attachment)
          session.module.prefillImages(
            imageTensor.values,
            imageTensor.width,
            imageTensor.height,
            imageTensor.channels,
          )
        }
        if (useHistory) {
          renderConversationalPrompt(historyMaps, prompt, session.runtimeOptions.promptTemplate, turnIndex)
        } else {
          renderTextPrompt(prompt, session.runtimeOptions.promptTemplate, turnIndex)
        }
      }
    }
  }

  private fun renderTextPrompt(prompt: String, promptTemplate: PromptTemplate, turnIndex: Int): String =
    when (promptTemplate) {
      PromptTemplate.PLAIN -> prompt
      PromptTemplate.CHATML ->
        if (turnIndex == 0) {
          "<|im_start|>system\nYou are a helpful assistant.<|im_end|>\n<|im_start|>user\n$prompt<|im_end|>\n<|im_start|>assistant\n"
        } else {
          "<|im_start|>user\n$prompt<|im_end|>\n<|im_start|>assistant\n"
        }
      PromptTemplate.GEMMA4_CHAT ->
        if (turnIndex == 0) {
          "<bos><|turn>user\n$prompt<turn|>\n<|turn>model\n"
        } else {
          "<|turn>user\n$prompt<turn|>\n<|turn>model\n"
        }
    }

  private data class ConversationEntry(val role: String, val content: String)

  private fun renderConversationalPrompt(
    history: List<Map<String, Any>>,
    newPrompt: String,
    promptTemplate: PromptTemplate,
    turnIndex: Int,
  ): String {
    val entries = history.mapNotNull {
      val role = it["role"] as? String ?: return@mapNotNull null
      val content = it["content"] as? String ?: return@mapNotNull null
      ConversationEntry(role, content)
    }
    return when (promptTemplate) {
      PromptTemplate.PLAIN -> {
        // Format conversation as a readable transcript with clear turn markers
        val sb = StringBuilder()
        for (entry in entries) {
          if (entry.role == "user") {
            sb.append("[User]\n${entry.content}\n\n")
          } else {
            sb.append("[Assistant]\n${entry.content}\n\n")
          }
        }
        sb.append("[User]\n${newPrompt}\n\n[Assistant]\n")
        sb.toString()
      }
      PromptTemplate.CHATML -> {
        val sb = StringBuilder("<|im_start|>system\nYou are a helpful assistant.<|im_end|>\n")
        for (entry in entries) {
          val roleTag = if (entry.role == "user") "user" else "assistant"
          sb.append("<|im_start|>${roleTag}\n${entry.content}<|im_end|>\n")
        }
        sb.append("<|im_start|>user\n${newPrompt}<|im_end|>\n<|im_start|>assistant\n")
        sb.toString()
      }
      PromptTemplate.GEMMA4_CHAT -> {
        val sb = StringBuilder()
        if (turnIndex == 0) sb.append("<bos>")
        for (entry in entries) {
          val roleTag = if (entry.role == "user") "user" else "model"
          sb.append("<|turn>${roleTag}\n${entry.content}<turn|>\n")
        }
        sb.append("<|turn>user\n${newPrompt}<turn|>\n<|turn>model\n")
        sb.toString()
      }
    }
  }

  private fun loadNormalizedImage(attachment: ChatAttachmentPayload): ImageTensor {
    if (attachment.type != "image") {
      throw IllegalArgumentException("Only image attachments are supported.")
    }

    val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable.")
    val uri = Uri.parse(attachment.localUri)
    val bitmap =
      when (uri.scheme?.lowercase(Locale.US)) {
        "content" ->
          context.contentResolver.openInputStream(uri)?.use(BitmapFactory::decodeStream)
            ?: throw IllegalArgumentException("Unable to open image attachment: ${attachment.id}")

        "file" -> BitmapFactory.decodeFile(uri.path)
        null -> BitmapFactory.decodeFile(attachment.localUri)
        else -> throw IllegalArgumentException("Unsupported attachment URI: ${attachment.localUri}")
      } ?: throw IllegalArgumentException("Unable to decode image attachment: ${attachment.localUri}")

    val scaledBitmap =
      if (bitmap.width == gemmaVisionTargetSize && bitmap.height == gemmaVisionTargetSize) {
        bitmap
      } else {
        Bitmap.createScaledBitmap(bitmap, gemmaVisionTargetSize, gemmaVisionTargetSize, true)
      }

    val planeSize = gemmaVisionTargetSize * gemmaVisionTargetSize
    val values = FloatArray(planeSize * 3)
    val pixels = IntArray(planeSize)
    scaledBitmap.getPixels(pixels, 0, gemmaVisionTargetSize, 0, 0, gemmaVisionTargetSize, gemmaVisionTargetSize)

    for (i in 0 until planeSize) {
      val pixel = pixels[i]
      values[i] = Color.red(pixel) / 255.0f
      values[planeSize + i] = Color.green(pixel) / 255.0f
      values[(planeSize * 2) + i] = Color.blue(pixel) / 255.0f
    }

    if (scaledBitmap !== bitmap) {
      bitmap.recycle()
    }
    scaledBitmap.recycle()

    return ImageTensor(
      values = values,
      width = gemmaVisionTargetSize,
      height = gemmaVisionTargetSize,
      channels = 3,
    )
  }

  private fun buildTelemetrySnapshot(
    ttftMs: Int,
    decodeTokensPerSecond: Double,
    peakMemoryMb: Int,
    queueDepth: Int,
    lastRoute: String,
  ): Map<String, Any> =
    mapOf(
      "ttftMs" to ttftMs,
      "decodeTokensPerSecond" to decodeTokensPerSecond,
      "peakMemoryMb" to peakMemoryMb,
      "queueDepth" to queueDepth,
      "lastRoute" to lastRoute,
    )

  private fun durationMs(startedAt: Long, finishedAt: Long): Int {
    if (finishedAt <= startedAt) {
      return 0
    }
    return ((finishedAt - startedAt) / 1_000_000L).toInt()
  }

  private fun fallbackDecodeTokensPerSecond(tokensGenerated: Int, firstTokenAt: Long, finishedAt: Long): Double {
    if (tokensGenerated <= 0 || firstTokenAt <= 0L || finishedAt <= firstTokenAt) {
      return 0.0
    }
    val seconds = (finishedAt - firstTokenAt).toDouble() / 1_000_000_000.0
    if (seconds <= 0.0) {
      return 0.0
    }
    return tokensGenerated / seconds
  }

  private fun outputStopTokens(template: PromptTemplate): Set<String> =
    when (template) {
      PromptTemplate.CHATML -> setOf("<|im_end|>", "<|endoftext|>", "<|startoftext|>")
      PromptTemplate.GEMMA4_CHAT -> setOf("<turn|>", "<end_of_turn>", "<eos>")
      PromptTemplate.PLAIN -> setOf("<|endoftext|>")
    }

  private fun stripOutputSpecialTokens(text: String, template: PromptTemplate): String {
    val stops = outputStopTokens(template)
    if (stops.isEmpty()) return text
    var firstIndex = text.length
    for (stop in stops) {
      val idx = text.indexOf(stop)
      if (idx in 0 until firstIndex) firstIndex = idx
    }
    return text.substring(0, firstIndex).trim()
  }

  private fun estimateTokenCount(text: String): Int {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) {
      return 0
    }
    return maxOf(1, (trimmed.length / 4.0).toInt())
  }

  private fun currentMemoryMb(): Int = (Debug.getNativeHeapAllocatedSize() / 1_048_576L).toInt()

  private val appLifecycleObserver = object : DefaultLifecycleObserver {
    override fun onStart(owner: LifecycleOwner) {
      sendEvent("onAppLifecycle", mapOf("event" to "willEnterForeground"))
    }

    override fun onStop(owner: LifecycleOwner) {
      sessions.values.forEach { session ->
        if (!session.isGenerating.get()) {
          withContext(Dispatchers.IO) {
            session.module.stop()
            session.module.resetContext()
          }
          session.isSuspended = true
        }
      }
      sendEvent("onAppLifecycle", mapOf("event" to "didEnterBackground"))
    }
  }
}
