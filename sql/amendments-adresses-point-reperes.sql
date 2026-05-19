-- Point de repère pour livraisons (quartiers informels, repères locaux)
ALTER TABLE adresses
  ADD COLUMN IF NOT EXISTS point_reperes TEXT;
