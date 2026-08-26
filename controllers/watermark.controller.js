const { getSupabaseClient } = require('../services/supabase.service');
const { addWatermark } = require('../utils/watermark');

const FOLDERS = ['products', 'campagnes'];

/**
 * POST /api/admin/watermark-migration
 *
 * Lance la migration watermark sur toutes les images existantes.
 * Query param: ?dry=true pour un dry run (aucune modification).
 *
 * Accessible uniquement aux admins.
 */
async function runWatermarkMigration(req, res, next) {
  try {
    const dryRun = req.query.dry === 'true';
    const supabase = getSupabaseClient();
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'public';

    let totalProcessed = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    const logs = [];

    for (const folder of FOLDERS) {
      const { data: files, error: listError } = await supabase.storage
        .from(bucket)
        .list(folder, { limit: 1000 });

      if (listError) {
        logs.push(`❌ ${folder}/: erreur listing — ${listError.message}`);
        continue;
      }

      if (!files || files.length === 0) {
        logs.push(`⏭️  ${folder}/: aucun fichier`);
        continue;
      }

      logs.push(`📁 ${folder}/: ${files.length} fichier(s)`);

      for (const file of files) {
        const objectPath = `${folder}/${file.name}`;

        if (!/\.(jpg|jpeg|png|webp)$/i.test(file.name)) {
          totalSkipped++;
          continue;
        }

        try {
          if (dryRun) {
            logs.push(`🔍 ${objectPath} — serais watermarké`);
            totalProcessed++;
            continue;
          }

          // Télécharger
          const { data: downloadData, error: dlError } = await supabase.storage
            .from(bucket)
            .download(objectPath);

          if (dlError) {
            logs.push(`❌ ${objectPath} — download: ${dlError.message}`);
            totalErrors++;
            continue;
          }

          const inputBuffer = Buffer.from(await downloadData.arrayBuffer());

          // Watermark
          const watermarkedBuffer = await addWatermark(inputBuffer);

          if (watermarkedBuffer === inputBuffer) {
            logs.push(`⏭️  ${objectPath} — watermark non appliqué`);
            totalSkipped++;
            continue;
          }

          // Ré-upload
          const contentType = file.metadata?.mimetype || 'image/jpeg';
          const { error: uploadError } = await supabase.storage
            .from(bucket)
            .upload(objectPath, watermarkedBuffer, {
              contentType,
              upsert: true,
            });

          if (uploadError) {
            logs.push(`❌ ${objectPath} — upload: ${uploadError.message}`);
            totalErrors++;
            continue;
          }

          logs.push(`✅ ${objectPath} — watermarké`);
          totalProcessed++;

          // Pause 100ms entre chaque upload
          await new Promise(r => setTimeout(r, 100));
        } catch (err) {
          logs.push(`❌ ${objectPath} — ${err.message}`);
          totalErrors++;
        }
      }
    }

    return res.json({
      dryRun,
      totalProcessed,
      totalSkipped,
      totalErrors,
      logs,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { runWatermarkMigration };
