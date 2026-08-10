export type TariffEntry = {
  code: string;
  official_code: string;
  description_he?: string;
  description_en?: string;
  customs_rate?: string;
  purchase_tax?: string;
  measurement_unit?: string;
  item_valid_until?: string;
  customs_rate_valid_until?: string;
  purchase_tax_valid_until?: string;
  customs_item_category_id?: number;
};

export type TariffMetadata = {
  retrieved_at: string;
  dataset_updated_at: string;
  source: "Israel Tax Authority";
  source_type: "official_open_data";
  source_dataset: "ספר סיווג טובין ביבוא";
  source_url: string;
  license: {
    id: "other-open";
    title: "אחר (פתוח)";
    terms_url: string;
  };
  resource_ids: {
    he: string;
    en: string;
  };
  resource_updated_at: {
    he: string;
    en: string;
  };
};

export type TariffResponse = TariffEntry & {
  dataset_updated_at: string;
  retrieved_at: string;
  source: "Israel Tax Authority";
  source_type: "official_open_data";
  source_dataset: "ספר סיווג טובין ביבוא";
  source_url: string;
  disclaimer: string;
};
