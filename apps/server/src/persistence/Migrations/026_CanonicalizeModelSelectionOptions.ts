import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { getDialect } from "./helpers.ts";

/**
 * Canonicalize `modelSelection.options` / `defaultModelSelection.options` from
 * the legacy object shape (`{ effort: "max", fastMode: true, ... }`) to the
 * current array-of-selections shape (`[{ id: "effort", value: "max" }, ...]`).
 *
 * Migration 016 introduced `modelSelection` with `options` stored as a
 * per-provider object. Later the schema was reshaped so that options are a
 * generic `Array<{ id, value }>` of user-selected option entries. Stored rows
 * from before the reshape still have the object shape and fail to decode.
 *
 * For each value in the legacy object:
 *   - string values are kept if non-empty after trim
 *   - boolean values are always kept (true | false)
 *   - any other value type (number, null, nested object/array) is dropped,
 *     matching the permissive client-side normalizer in composerDraftStore.
 *
 * Touched storage:
 *   - `projection_threads.model_selection_json.options`
 *   - `projection_projects.default_model_selection_json.options`
 *   - `orchestration_events.payload_json.$.modelSelection.options`
 *     (thread.created | thread.meta-updated | thread.turn-start-requested)
 *   - `orchestration_events.payload_json.$.defaultModelSelection.options`
 *     (project.created | project.meta-updated)
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const dialect = yield* getDialect;

  if (dialect === "postgresql") {
    yield* sql`
      UPDATE projection_threads
      SET model_selection_json = jsonb_set(
        model_selection_json::jsonb,
        '{options}',
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', kv.key,
              'value',
              CASE jsonb_typeof(kv.value)
                WHEN 'boolean' THEN kv.value
                WHEN 'string' THEN CASE WHEN trim(kv.value #>> '{}') != '' THEN kv.value ELSE NULL END
                ELSE NULL
              END
            )
          )
          FROM jsonb_each(model_selection_json::jsonb->'options') AS kv
          WHERE jsonb_typeof(kv.value) = 'boolean'
            OR (jsonb_typeof(kv.value) = 'string' AND trim(kv.value #>> '{}') != '')
        )
      )::text
      WHERE model_selection_json IS NOT NULL
        AND jsonb_typeof(model_selection_json::jsonb->'options') = 'object'
    `;
  } else {
    yield* sql`
      UPDATE projection_threads
      SET model_selection_json = json_set(
        model_selection_json,
        '$.options',
        (
          SELECT json_group_array(
            json_object(
              'id', key,
              'value',
              CASE type
                WHEN 'true' THEN json('true')
                WHEN 'false' THEN json('false')
                ELSE atom
              END
            )
          )
          FROM json_each(json_extract(model_selection_json, '$.options'))
          WHERE (type = 'text' AND trim(coalesce(atom, '')) != '')
             OR type IN ('true', 'false')
        )
      )
      WHERE model_selection_json IS NOT NULL
        AND json_type(model_selection_json, '$.options') = 'object'
    `;
  }

  if (dialect === "postgresql") {
    yield* sql`
      UPDATE projection_projects
      SET default_model_selection_json = jsonb_set(
        default_model_selection_json::jsonb,
        '{options}',
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', kv.key,
              'value',
              CASE jsonb_typeof(kv.value)
                WHEN 'boolean' THEN kv.value
                WHEN 'string' THEN CASE WHEN trim(kv.value #>> '{}') != '' THEN kv.value ELSE NULL END
                ELSE NULL
              END
            )
          )
          FROM jsonb_each(default_model_selection_json::jsonb->'options') AS kv
          WHERE jsonb_typeof(kv.value) = 'boolean'
            OR (jsonb_typeof(kv.value) = 'string' AND trim(kv.value #>> '{}') != '')
        )
      )::text
      WHERE default_model_selection_json IS NOT NULL
        AND jsonb_typeof(default_model_selection_json::jsonb->'options') = 'object'
    `;
  } else {
    yield* sql`
      UPDATE projection_projects
      SET default_model_selection_json = json_set(
        default_model_selection_json,
        '$.options',
        (
          SELECT json_group_array(
            json_object(
              'id', key,
              'value',
              CASE type
                WHEN 'true' THEN json('true')
                WHEN 'false' THEN json('false')
                ELSE atom
              END
            )
          )
          FROM json_each(json_extract(default_model_selection_json, '$.options'))
          WHERE (type = 'text' AND trim(coalesce(atom, '')) != '')
             OR type IN ('true', 'false')
        )
      )
      WHERE default_model_selection_json IS NOT NULL
        AND json_type(default_model_selection_json, '$.options') = 'object'
    `;
  }

  if (dialect === "postgresql") {
    yield* sql`
      UPDATE orchestration_events
      SET payload_json = jsonb_set(
        payload_json::jsonb,
        '{modelSelection,options}',
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', kv.key,
              'value',
              CASE jsonb_typeof(kv.value)
                WHEN 'boolean' THEN kv.value
                WHEN 'string' THEN CASE WHEN trim(kv.value #>> '{}') != '' THEN kv.value ELSE NULL END
                ELSE NULL
              END
            )
          )
          FROM jsonb_each(payload_json::jsonb->'modelSelection'->'options') AS kv
          WHERE jsonb_typeof(kv.value) = 'boolean'
            OR (jsonb_typeof(kv.value) = 'string' AND trim(kv.value #>> '{}') != '')
        )
      )::text
      WHERE event_type IN (
        'thread.created',
        'thread.meta-updated',
        'thread.turn-start-requested'
      )
        AND jsonb_typeof(payload_json::jsonb->'modelSelection'->'options') = 'object'
    `;
  } else {
    yield* sql`
      UPDATE orchestration_events
      SET payload_json = json_set(
        payload_json,
        '$.modelSelection.options',
        (
          SELECT json_group_array(
            json_object(
              'id', key,
              'value',
              CASE type
                WHEN 'true' THEN json('true')
                WHEN 'false' THEN json('false')
                ELSE atom
              END
            )
          )
          FROM json_each(json_extract(payload_json, '$.modelSelection.options'))
          WHERE (type = 'text' AND trim(coalesce(atom, '')) != '')
             OR type IN ('true', 'false')
        )
      )
      WHERE event_type IN (
        'thread.created',
        'thread.meta-updated',
        'thread.turn-start-requested'
      )
        AND json_type(payload_json, '$.modelSelection.options') = 'object'
    `;
  }

  if (dialect === "postgresql") {
    yield* sql`
      UPDATE orchestration_events
      SET payload_json = jsonb_set(
        payload_json::jsonb,
        '{defaultModelSelection,options}',
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', kv.key,
              'value',
              CASE jsonb_typeof(kv.value)
                WHEN 'boolean' THEN kv.value
                WHEN 'string' THEN CASE WHEN trim(kv.value #>> '{}') != '' THEN kv.value ELSE NULL END
                ELSE NULL
              END
            )
          )
          FROM jsonb_each(payload_json::jsonb->'defaultModelSelection'->'options') AS kv
          WHERE jsonb_typeof(kv.value) = 'boolean'
            OR (jsonb_typeof(kv.value) = 'string' AND trim(kv.value #>> '{}') != '')
        )
      )::text
      WHERE event_type IN ('project.created', 'project.meta-updated')
        AND jsonb_typeof(payload_json::jsonb->'defaultModelSelection'->'options') = 'object'
    `;
  } else {
    yield* sql`
      UPDATE orchestration_events
      SET payload_json = json_set(
        payload_json,
        '$.defaultModelSelection.options',
        (
          SELECT json_group_array(
            json_object(
              'id', key,
              'value',
              CASE type
                WHEN 'true' THEN json('true')
                WHEN 'false' THEN json('false')
                ELSE atom
              END
            )
          )
          FROM json_each(json_extract(payload_json, '$.defaultModelSelection.options'))
          WHERE (type = 'text' AND trim(coalesce(atom, '')) != '')
             OR type IN ('true', 'false')
        )
      )
      WHERE event_type IN ('project.created', 'project.meta-updated')
        AND json_type(payload_json, '$.defaultModelSelection.options') = 'object'
    `;
  }
});
