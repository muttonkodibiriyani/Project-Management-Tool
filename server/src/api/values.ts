import { editsGate, type Actor } from '../access/policy.js';
import type { Db } from '../db/tx.js';
import { ApiError, invalid, type FieldError } from './problem.js';

export type Scope = 'line' | 'line_store' | 'brand' | 'brand_market' | 'install';

export interface FieldDef {
  key: string;
  label: string;
  type: string;
  isGate: boolean;
  ownerTeam: string | null;
  /** Option key → archived, for select, multiselect and fixture fields. */
  options: Map<string, boolean>;
}

/** The fields of one scope: the template's own plus the workspace-wide ones (brand and brand × market fields). */
export async function loadFields(db: Db, workspaceId: string, templateId: string | null, scope: Scope): Promise<Map<string, FieldDef>> {
  const { rows } = await db.query<{
    key: string;
    label: string;
    type: string;
    is_gate: boolean;
    owner_team: string | null;
    options: [string, boolean][] | null;
  }>(
    `select f.key, f.label, f.type, f.is_gate, t.key as owner_team,
            (select json_agg(json_build_array(o.key, o.archived)) from list_option o where o.list_id = f.list_id) as options
       from field_def f left join team t on t.id = f.owner_team_id
      where f.workspace_id = $1 and f.scope = $3 and f.deleted_at is null
        and (f.template_id is null or f.template_id = $2)`,
    [workspaceId, templateId, scope],
  );
  return new Map(
    rows.map(row => [
      row.key,
      { key: row.key, label: row.label, type: row.type, isGate: row.is_gate, ownerTeam: row.owner_team, options: new Map(row.options ?? []) },
    ]),
  );
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function checkValue(field: FieldDef, value: unknown, path: string): FieldError | undefined {
  const option = (key: unknown): FieldError | undefined => {
    if (typeof key !== 'string') return { path, code: 'invalid_type', message: `${field.label} takes an option key.` };
    const archived = field.options.get(key);
    if (archived === undefined) return { path, code: 'unknown_option', message: `'${key}' is not a value of ${field.label}.` };
    if (archived) return { path, code: 'archived_option', message: `'${key}' is no longer offered for ${field.label}; pick a current value.` };
    return undefined;
  };
  const type = (ok: boolean, what: string): FieldError | undefined =>
    ok ? undefined : { path, code: 'invalid_type', message: `${field.label} must be ${what}.` };
  switch (field.type) {
    case 'select':
      return option(value);
    case 'multiselect':
      return Array.isArray(value) ? value.map(option).find(Boolean) : type(false, 'a list of option keys');
    case 'text':
      if (typeof value !== 'string') return type(false, 'text');
      return value.length > 4000 ? { path, code: 'too_long', message: `${field.label} is over 4,000 characters.` } : undefined;
    case 'number':
      return type(typeof value === 'number' && Number.isFinite(value), 'a number');
    case 'integer':
      return type(Number.isInteger(value), 'a whole number');
    case 'date':
      return typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(value))
        ? undefined
        : { path, code: 'invalid_date', message: 'Use YYYY-MM-DD.' };
    case 'boolean':
      return type(typeof value === 'boolean', 'true or false');
    case 'store_ref':
    case 'member_ref':
      return type(typeof value === 'string' && UUID.test(value), 'an id');
    case 'store_or_market_ref':
      return type(
        isObject(value) &&
          Object.keys(value).length === 1 &&
          ((typeof value.store === 'string' && UUID.test(value.store)) || (typeof value.market === 'string' && /^[A-Z]{3}$/.test(value.market))),
        '{"store": id} or {"market": code}',
      );
    case 'fixture': {
      if (!isObject(value)) return type(false, 'a fixture');
      const { asWritten, type: fixtureType, widthFt, shelves, temporary, ...rest } = value;
      const valid =
        Object.keys(rest).length === 0 &&
        typeof asWritten === 'string' &&
        (widthFt === null || (typeof widthFt === 'number' && widthFt >= 0)) &&
        (shelves === null || Number.isInteger(shelves)) &&
        typeof temporary === 'boolean';
      if (!valid) return type(false, '{asWritten, type, widthFt, shelves, temporary}');
      return fixtureType === null ? undefined : option(fixtureType);
    }
    default:
      return { path, code: 'invalid_type', message: `${field.label} has an unknown type ${field.type}.` };
  }
}

/**
 * Checks a `values` merge patch: every key a field of this scope, every value of the field's type, and the caller
 * allowed to edit it (gates by their owner team, other fields when `editsOthers`). Forbidden → 403 field_forbidden, nothing written.
 */
export function checkValues(fields: Map<string, FieldDef>, patch: Record<string, unknown>, actor: Actor, editsOthers: boolean, prefix = 'values'): void {
  const forbidden: FieldError[] = [];
  const errors: FieldError[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const path = `${prefix}.${key}`;
    const field = fields.get(key);
    if (!field) {
      errors.push({ path, code: 'unknown_field', message: `${key} is not a field here.` });
      continue;
    }
    if (field.isGate ? !editsGate(actor, field.ownerTeam) : !editsOthers) {
      forbidden.push({
        path,
        code: 'forbidden',
        message: field.isGate ? `${field.label} is edited by the ${field.ownerTeam ?? 'owner'} team.` : `You may not edit ${field.label} here.`,
      });
      continue;
    }
    if (value === null) continue;
    const error = checkValue(field, value, path);
    if (error) errors.push(error);
  }
  if (forbidden.length > 0) {
    throw new ApiError(403, 'field_forbidden', `You may not change ${forbidden.map(error => error.path).join(', ')}. Nothing was saved.`, {
      errors: forbidden,
    });
  }
  if (errors.length > 0) throw invalid(errors);
}

/** Null removes a key, so stored values never hold nulls (a missing key and null both mean empty). */
export const withoutNulls = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null));
