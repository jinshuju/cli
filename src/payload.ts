import { UsageError } from './errors.js';

const API_V1_FIELD_TYPES = new Set([
  'TextField',
  'TextArea',
  'NumberField',
  'EmailField',
  'MobileField',
  'TelephoneField',
  'IdCardField',
  'NameField',
  'AddressField',
  'LinkField',
  'GeoField',
  'AttachmentField',
  'DateTimeField',
  'TimeField',
  'RatingField',
  'NpsField',
  'RadioButton',
  'CheckBox',
  'DropDown',
  'TableField',
  'CascadeDropDown',
  'SortField',
  'LikertField',
  'MatrixField',
  'MatrixScaleField',
  'ImageRadioButton',
  'ImageCheckBox',
  'GoodsField',
  'FormulaField',
  'ReservationField',
  'FormAssociation',
  'ESignatureField',
  'AudioField',
  'PageBreak',
  'SectionBreak',
  'WidgetButton',
  'WidgetContact',
  'WidgetMap',
  'WidgetMarquee'
]);

/**
 * The question types only a scorable scene has. They are not Fields::* classes
 * of their own — each persists as a base field plus a customized_type and the
 * correct answers — which is why they are absent from the list above and were
 * being refused here: `--type exam` could create an exam-scene form and then
 * not one question that scores, the only thing the scene is for.
 *
 * Which scene accepts which is the server's answer, and it names them in the
 * refusal; there is nothing to duplicate here beyond letting them through.
 */
const SCENE_FIELD_TYPES = new Set([
  'SingleSelect',
  'MultiSelect',
  'ImageSingleSelect',
  'ImageMultiSelect',
  'TrueOrFalse',
  'DropDownSelect',
  'FillInBlank',
  'ShortAnswer',
  'FillInNumber',
  'Rating',
  'Nps',
  'Department',
  'Grade'
]);

export type FormCreatePayload = {
  name: string;
  description?: string;
  fields: Array<Record<string, unknown> & { type: string; label?: string }>;
  setting?: Record<string, unknown>;
  folder_token?: string;
};

export function validateCreateFormPayload(payload: unknown): FormCreatePayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new UsageError('Form payload must be a JSON object');
  }
  const form = payload as Record<string, unknown>;
  if (typeof form.name !== 'string' || form.name.trim() === '') {
    throw new UsageError('Form payload requires non-empty name');
  }
  if (!Array.isArray(form.fields) || form.fields.length === 0) {
    throw new UsageError('Form payload requires at least one field');
  }
  for (const field of form.fields) {
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      throw new UsageError('Each field must be an object');
    }
    const fieldObject = field as Record<string, unknown>;
    if ('api_code' in fieldObject) {
      throw new UsageError('Do not pass api_code when creating fields; backend generates it');
    }
    if (
      typeof fieldObject.type !== 'string' ||
      !(API_V1_FIELD_TYPES.has(fieldObject.type) || SCENE_FIELD_TYPES.has(fieldObject.type))
    ) {
      throw new UsageError(`Field type must be an API v1 field type, got ${String(fieldObject.type)}`);
    }
    if (typeof fieldObject.label !== 'string' && fieldObject.type !== 'PageBreak') {
      throw new UsageError('Each field requires label');
    }
  }
  return form as FormCreatePayload;
}
