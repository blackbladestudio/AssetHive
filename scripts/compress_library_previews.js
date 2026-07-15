const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

let sharp = null;
try {
  sharp = require("sharp");
} catch (err) {
  console.error("Error: sharp module not found. Please run 'npm install' first.");
  process.exit(1);
}

// 配置参数
const TARGET_LIBRARY = String(process.argv[2] || "").trim();
if (!TARGET_LIBRARY) {
  console.error("Usage: node compress_library_previews.js <library-path>");
  process.exit(2);
}
const MAX_WIDTH = 1024;
const MAX_HEIGHT = 1024;
const JPEG_QUALITY = 72;
const MIN_SIZE_TO_COMPRESS = 1.5 * 1024 * 1024; // 只有超过 1.5MB 的才处理
const CONCURRENCY = Math.max(1, os.cpus().length - 1); // 留一个核心给系统

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function compressImage(filePath) {
  try {
    const stats = await fs.stat(filePath);
    if (stats.size < MIN_SIZE_TO_COMPRESS) {
      return { skipped: true, reason: "size-ok" };
    }

    const metadata = await sharp(filePath).metadata();
    const { width, height, format, hasAlpha } = metadata;

    if (!width || !height) return { skipped: true, reason: "invalid-image" };

    if (width <= MAX_WIDTH && height <= MAX_HEIGHT && stats.size < MIN_SIZE_TO_COMPRESS) {
      return { skipped: true, reason: "already-optimized" };
    }

    const tempPath = path.join(os.tmpdir(), `ah_compress_${Date.now()}_${Math.random().toString(36).substring(7)}_${path.basename(filePath)}`);
    
    let pipeline = sharp(filePath).rotate();

    if (width > MAX_WIDTH || height > MAX_HEIGHT) {
      pipeline = pipeline.resize(MAX_WIDTH, MAX_HEIGHT, {
        fit: "inside",
        withoutEnlargement: true
      });
    }

    const shouldConvertToJpg = !hasAlpha && format !== "jpeg";
    const finalPath = shouldConvertToJpg 
      ? filePath.replace(/\.[^.]+$/, ".jpg") 
      : filePath;

    if (shouldConvertToJpg || format === "jpeg" || !hasAlpha) {
      await pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toFile(tempPath);
    } else {
      await pipeline.png({ compressionLevel: 9 }).toFile(tempPath);
    }

    if (finalPath !== filePath) {
      await fs.unlink(filePath);
    }
    await fs.copyFile(tempPath, finalPath);
    await fs.unlink(tempPath);

    const newStats = await fs.stat(finalPath);
    const saved = stats.size - newStats.size;

    return { 
      success: true, 
      savedBytes: saved,
      converted: finalPath !== filePath
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function collectTargetFiles(dir) {
  const targets = [];
  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        const isPreview = entry.name.toLowerCase().includes("preview") && 
                         (ext === ".png" || ext === ".jpg" || ext === ".jpeg");
        if (isPreview) {
          targets.push(fullPath);
        }
      }
    }
  }
  await walk(dir);
  return targets;
}

async function scanAndProcess(dir) {
  console.log(`[INFO] Scanning for preview images in: ${dir}...`);
  
  const targetFiles = await collectTargetFiles(dir);
  const totalFiles = targetFiles.length;
  
  if (totalFiles === 0) {
    console.log("[INFO] No preview images found to process.");
    return;
  }

  console.log(`[INFO] Found ${totalFiles} preview images. Starting parallel compression (Concurrency: ${CONCURRENCY})...`);
  console.log("----------------------------------------------------");

  let processedCount = 0;
  let successCount = 0;
  let failedCount = 0;
  let totalSavedBytes = 0;

  // 并发队列执行
  const worker = async () => {
    while (targetFiles.length > 0) {
      const file = targetFiles.pop();
      if (!file) continue;

      const result = await compressImage(file);
      processedCount++;

      if (result.success) {
        successCount++;
        totalSavedBytes += result.savedBytes;
      } else if (!result.skipped) {
        failedCount++;
      }

      // 每处理 10 个打印一次进度，或者到达最后一个
      if (processedCount % 10 === 0 || processedCount === totalFiles) {
        const savedMb = (totalSavedBytes / (1024 * 1024)).toFixed(2);
        console.log(`Processed ${processedCount}/${totalFiles} images | Saved: ${savedMb} MB | Failed: ${failedCount}`);
      }
    }
  };

  const workers = Array(CONCURRENCY).fill(null).map(() => worker());
  await Promise.all(workers);

  const totalSavedMb = (totalSavedBytes / (1024 * 1024)).toFixed(2);
  console.log("\n====================================================");
  console.log("  Optimization Finished");
  console.log("====================================================");
  console.log(`- Total Images Processed: ${totalFiles}`);
  console.log(`- Successfully Compressed: ${successCount}`);
  console.log(`- Failed to Compress: ${failedCount}`);
  console.log(`- Total Space Saved: ${totalSavedMb} MB`);
}

scanAndProcess(TARGET_LIBRARY);
