const API_V1_FIELD_TYPES = new Set([
  'TextField', 'TextArea', 'NumberField', 'EmailField', 'MobileField', 'TelephoneField', 'IdCardField',
  'NameField', 'AddressField', 'LinkField', 'GeoField', 'AttachmentField', 'DateTimeField', 'TimeField',
  'RatingField', 'NpsField', 'RadioButton', 'CheckBox', 'DropDown', 'TableField', 'CascadeDropDown',
  'SortField', 'LikertField', 'MatrixField', 'MatrixScaleField', 'ImageRadioButton', 'ImageCheckBox',
  'GoodsField', 'FormulaField', 'ReservationField', 'FormAssociation', 'ESignatureField', 'AudioField',
  'PageBreak', 'SectionBreak', 'WidgetButton', 'WidgetContact', 'WidgetMap', 'WidgetMarquee'
]);

export type FormCreatePayload = {
  name: string;
  description?: string;
  fields: Array<Record<string, unknown> & { type: string; label?: string }>;
  setting?: Record<string, unknown>;
  folder_token?: string;
};

export function parseJsonPayload(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON payload: ${(error as Error).message}`);
  }
}

export function validateCreateFormPayload(payload: unknown): FormCreatePayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Form payload must be a JSON object');
  }
  const form = payload as Record<string, unknown>;
  if (typeof form.name !== 'string' || form.name.trim() === '') {
    throw new Error('Form payload requires non-empty name');
  }
  if (!Array.isArray(form.fields) || form.fields.length === 0) {
    throw new Error('Form payload requires at least one field');
  }
  for (const field of form.fields) {
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      throw new Error('Each field must be an object');
    }
    const fieldObject = field as Record<string, unknown>;
    if ('api_code' in fieldObject) {
      throw new Error('Do not pass api_code when creating fields; backend generates it');
    }
    if (typeof fieldObject.type !== 'string' || !API_V1_FIELD_TYPES.has(fieldObject.type)) {
      throw new Error(`Field type must be an API v1 field type, got ${String(fieldObject.type)}`);
    }
    if (typeof fieldObject.label !== 'string' && fieldObject.type !== 'PageBreak') {
      throw new Error('Each field requires label');
    }
  }
  return form as FormCreatePayload;
}
