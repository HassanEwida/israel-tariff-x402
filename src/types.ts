export type TariffEntry = {
  code: string;
  description_he?: string;
  description_en?: string;
  customs_rate?: string;
  purchase_tax?: string;
  effective_date?: string;
};

export type TariffResponse = TariffEntry & {
  source: "Israel Tax Authority";
  source_type: "official";
  disclaimer: string;
};
