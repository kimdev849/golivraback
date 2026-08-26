/**
 * Migration : ajouter le watermark GoLivra aux images existantes.
 *
 * Usage :
 *   node sql/watermark-existing-images.js [--dry-run]
 *
 * Ce script :
 * 1. Liste tous les fichiers dans les dossiers products/ et campagnes/ de Supabase Storage
 * 2. Télécharge chaque image
 * 3. Ajoute le watermark GoLivra via sharp
 * 4. Ré-upload l'image watermarkée (écrase l'originale)
 *
 * Prérequis :
 * - npm install sharp
 * - Variables d'env SUPABASE_URL, SUPABASE_SERVICE_KEY (ou SUPABASE_KEY)
 * - ou un fichier .env à la racine de golivraback/
 *
 * ⚠️  Ce script est IRRÉVERSIBLE. Faites un backup avant de l'exécuter.
 */

const { getSupabaseClient } = require('../services/supabase.service');
const { addWatermark } = require('../utils/watermark');

const DRY_RUN = process.argv.includes('--dry-run');
const FOLDERS = ['products', 'campagnes'];

async function main() {
  const supabase = getSupabaseClient();
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'public';

  console.log(`\n🏷️  Watermark Migration — GoLivra`);
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN (aucune modification)' : 'LIVE'}`);
  console.log(`   Bucket: ${bucket}`);
  console.log(`   Dossiers: ${FOLDERS.join(', ')}\n`);

  let totalProcessed = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const folder of FOLDERS) {
    console.log(`\n📁 Dossier: ${folder}/`);

    const { data: files, error: listError } = await supabase.storage
      .from(bucket)
      .list(folder, { limit: 1000 });

    if (listError) {
      console.error(`   ❌ Erreur listing: ${listError.message}`);
      continue;
    }

    if (!files || files.length === 0) {
      console.log(`   ⏭️  Aucun fichier trouvé`);
      continue;
    }

    console.log(`   📄 ${files.length} fichier(s) trouvé(s)`);

    for (const file of files) {
      const objectPath = `${folder}/${file.name}`;

      // Ignorer les fichiers non-image
      if (!/\.(jpg|jpeg|png|webp)$/i.test(file.name)) {
        console.log(`   ⏭️  ${file.name} — format non supporté, ignoré`);
        totalSkipped++;
        continue;
      }

      try {
        if (DRY_RUN) {
          console.log(`   🔍 ${file.name} — serait watermarké (${(file.metadata?.size / 1024).toFixed(0)} KB)`);
          totalProcessed++;
          continue;
        }

        // Télécharger l'image
        const { data: downloadData, error: dlError } = await supabase.storage
          .from(bucket)
          .download(objectPath);

        if (dlError) {
          console.error(`   ❌ ${file.name} — téléchargement échoué: ${dlError.message}`);
          totalErrors++;
          continue;
        }

        const inputBuffer = Buffer.from(await downloadData.arrayBuffer());

        // Ajouter le watermark
        const watermarkedBuffer = await addWatermark(inputBuffer);

        // Vérifier que le buffer a changé (watermark appliqué)
        if (watermarkedBuffer === inputBuffer) {
          console.log(`   ⏭️  ${file.name} — watermark non appliqué (erreur silencieuse)`);
          totalSkipped++;
          continue;
        }

        // Ré-upload l'image watermarkée
        const contentType = file.metadata?.mimetype || 'image/jpeg';
        const { error: uploadError } = await supabase.storage
          .from(bucket)
          .upload(objectPath, watermarkedBuffer, {
            contentType,
            upsert: true,
          });

        if (uploadError) {
          console.error(`   ❌ ${file.name} — upload échoué: ${uploadError.message}`);
          totalErrors++;
          continue;
        }

        const savedKB = ((inputBuffer.length - watermarkedBuffer.length) / 1024).toFixed(0);
        console.log(`   ✅ ${file.name} — watermarké (${savedKB} KB)`);
        totalProcessed++;

        // Pause pour ne pas surcharger Supabase
        await new Promise(r => setTimeout(r, 100));
      } catch (err) {
        console.error(`   ❌ ${file.name} — erreur: ${err.message}`);
        totalErrors++;
      }
    }
  }

  console.log(`\n📊 Résumé:`);
  console.log(`   ✅ Traités: ${totalProcessed}`);
  console.log(`   ⏭️  Ignorés: ${totalSkipped}`);
  console.log(`   ❌ Erreurs: ${totalErrors}`);
  console.log(`\n${DRY_RUN ? 'ℹ️  Mode dry run — aucune modification effectuée.' : '✅ Migration terminée !'}\n`);
}

main().catch((err) => {
  console.error('\n❌ Erreur fatale:', err);
  process.exit(1);
});
