-- INV-ITEM-02: a minimum stock per item; below it the item shows as «заканчивается».
ALTER TABLE inventory_items ADD COLUMN min_qty numeric(14, 3) NOT NULL DEFAULT 0 CHECK (min_qty >= 0);
