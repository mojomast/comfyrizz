import { createHash } from 'node:crypto';

export const RETENTION_SCHEMA = 'comfyrizz.retention/v1';
export const IMPORT_SCHEMA = 'comfyrizz.import/v1';

const DEFAULT_VERSION_WINDOW = 2;
const HASH_PREFIX_RE = /^sha256[:=]/i;
const DECISION_ACCEPTED = new Set(['accepted', 'approved', 'resolved']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isThenable(value) {
  return Boolean(value) && typeof value.then === 'function';
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function normalizeDigest(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.replace(HASH_PREFIX_RE, '').toLowerCase();
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function bytesFrom(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (isPlainObject(value)) {
    const nested = value.bytes ?? value.data ?? value.buffer;
    if (nested !== undefined) return bytesFrom(nested);
  }
  return null;
}

function digestFromHashResult(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return normalizeDigest(value);
  const bytes = bytesFrom(value);
  if (bytes) return hashBytes(bytes);
  if (isPlainObject(value)) {
    const digest = value.sha256 ?? value.contentHash ?? value.hash ?? value.digest;
    if (digest !== undefined) return normalizeDigest(digest);
  }
  return null;
}

function resolveReferences(input) {
  const source = isPlainObject(input) ? input : {};
  const nestedKeys = [
    'artifacts',
    'decisions',
    'deliveries',
    'production',
    'refs',
    'explicitRefs',
    'pinnedIds',
    'keepIds',
    'importedIds',
    'imported',
  ];
  const referencesIsContainer = isPlainObject(source.references)
    && Object.keys(source.references).some((key) => nestedKeys.includes(key));
  const nested = referencesIsContainer ? source.references : {};
  const explicit = Array.isArray(source.references)
    ? source.references
    : firstDefined(
      source.explicitRefs,
      source.refs,
      referencesIsContainer ? undefined : source.references,
      nested.explicitRefs,
      nested.refs,
    );

  return {
    artifacts: asArray(firstDefined(source.artifacts, nested.artifacts)),
    decisions: asArray(firstDefined(source.decisions, nested.decisions)),
    deliveries: asArray(firstDefined(source.deliveries, nested.deliveries)),
    production: firstDefined(source.production, nested.production, null),
    explicitRefs: explicit,
    pinnedIds: asArray(firstDefined(source.pinnedIds, nested.pinnedIds)),
    keepIds: asArray(firstDefined(source.keepIds, nested.keepIds)),
    importedIds: asArray(firstDefined(source.importedIds, nested.importedIds)),
    importedRecords: asArray(firstDefined(source.imported, nested.imported)),
  };
}

function hasReferenceInputs(input) {
  if (!isPlainObject(input)) return false;
  return [
    'artifacts',
    'decisions',
    'deliveries',
    'production',
    'references',
    'explicitRefs',
    'refs',
    'pinnedIds',
    'keepIds',
    'importedIds',
    'imported',
  ].some((key) => input[key] !== undefined);
}

function addExplicitRefs(value, ids, seen) {
  if (typeof value === 'string') {
    if (value.trim() !== '') ids.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) addExplicitRefs(entry, ids, seen);
    return;
  }
  if (!isPlainObject(value) || seen.has(value)) return;
  seen.add(value);

  for (const key of ['id', 'artifactId', 'artifactVersionId']) {
    if (typeof value[key] === 'string' && value[key].trim() !== '') ids.add(value[key]);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'id' || key === 'artifactId' || key === 'artifactVersionId') continue;
    if (key.trim() !== '') ids.add(key);
    addExplicitRefs(entry, ids, seen);
  }
}

function addArtifactRefValue(value, ids, seen, inArtifactContext = false) {
  if (typeof value === 'string') {
    if (value.trim() !== '') ids.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) addArtifactRefValue(entry, ids, seen, inArtifactContext);
    return;
  }
  if (!isPlainObject(value) || seen.has(value)) return;
  seen.add(value);

  if (inArtifactContext) {
    for (const key of ['id', 'artifactId', 'artifactVersionId', 'sourceArtifactId']) {
      if (typeof value[key] === 'string' && value[key].trim() !== '') ids.add(value[key]);
    }
  }

  for (const [key, entry] of Object.entries(value)) {
    const artifactish = /artifact|take|source|lineage|versionId/i.test(key);
    if (artifactish) addArtifactRefValue(entry, ids, seen, true);
    else if (inArtifactContext && key === 'id' && typeof entry === 'string') ids.add(entry);
    else if (entry !== null && typeof entry === 'object') {
      addArtifactRefValue(entry, ids, seen, inArtifactContext);
    }
  }
}

function collectProtectedIds(references) {
  const referenced = new Set();

  for (const artifact of references.artifacts) {
    if (!isPlainObject(artifact)) continue;
    for (const source of asArray(artifact.derivedFrom)) {
      if (isPlainObject(source) && typeof source.artifactId === 'string') referenced.add(source.artifactId);
    }
  }

  for (const item of references.decisions) {
    if (!isPlainObject(item)) continue;
    for (const target of asArray(item.targetIds)) {
      if (typeof target === 'string') referenced.add(target);
    }
    for (const option of asArray(item.options)) {
      if (!isPlainObject(option)) continue;
      for (const artifactId of asArray(option.artifactIds)) {
        if (typeof artifactId === 'string') referenced.add(artifactId);
      }
    }
    for (const key of ['artifactId', 'sourceArtifactId', 'artifactVersionId']) {
      if (typeof item[key] === 'string') referenced.add(item[key]);
    }
  }

  const deliverySeen = new WeakSet();
  for (const delivery of references.deliveries) {
    addArtifactRefValue(delivery, referenced, deliverySeen);
  }

  if (isPlainObject(references.production)) {
    const production = references.production;
    for (const key of ['briefVersionId', 'scriptVersionId']) {
      if (typeof production[key] === 'string' && production[key].trim() !== '') referenced.add(production[key]);
    }
    for (const binding of asArray(production.characterBindings)) {
      if (!isPlainObject(binding)) continue;
      for (const key of ['artifactId', 'artifactVersionId']) {
        if (typeof binding[key] === 'string' && binding[key].trim() !== '') referenced.add(binding[key]);
      }
    }
    const productionSeen = new WeakSet();
    for (const key of ['artifactIds', 'artifacts', 'pinnedIds', 'references']) {
      if (production[key] !== undefined) addArtifactRefValue(production[key], referenced, productionSeen, true);
    }
  }

  if (references.explicitRefs !== undefined) {
    addExplicitRefs(references.explicitRefs, referenced, new WeakSet());
  }

  const pinned = new Set();
  for (const id of references.pinnedIds) {
    if (typeof id === 'string') pinned.add(id);
  }
  for (const id of references.keepIds) {
    if (typeof id === 'string') referenced.add(id);
  }

  return { referenced, pinned, protectedIds: new Set([...referenced, ...pinned]) };
}

function normalizeWindow(input) {
  const value = firstDefined(
    input.versionWindow,
    input.keepVersions,
    input.retainVersions,
    input.versionsToKeep,
    input.maxVersions,
    input.window,
  );
  if (value === undefined) return DEFAULT_VERSION_WINDOW;
  if (!Number.isSafeInteger(value) || value < 0) return DEFAULT_VERSION_WINDOW;
  return value;
}

function isImportedArtifact(artifact) {
  if (!isPlainObject(artifact)) return false;
  if (artifact.imported === true) return true;
  const provenance = artifact.provenance;
  if (!isPlainObject(provenance)) return false;
  return provenance.imported === true || provenance.source === 'import' || provenance.origin === 'import';
}

function groupArtifacts(artifacts) {
  const grouped = new Map();
  for (const artifact of artifacts) {
    if (!isPlainObject(artifact) || typeof artifact.id !== 'string') continue;
    const logicalId = typeof artifact.logicalId === 'string' && artifact.logicalId !== ''
      ? artifact.logicalId
      : `__artifact__${artifact.id}`;
    if (!grouped.has(logicalId)) grouped.set(logicalId, []);
    grouped.get(logicalId).push(artifact);
  }
  for (const versions of grouped.values()) {
    versions.sort((a, b) => {
      const versionDiff = (Number(b.version) || 0) - (Number(a.version) || 0);
      return versionDiff !== 0 ? versionDiff : String(a.id).localeCompare(String(b.id));
    });
  }
  return grouped;
}

export function planRetention(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const references = resolveReferences(source);
  const window = normalizeWindow(source);
  const keepImported = source.keepImported !== false;
  const { referenced, pinned, protectedIds } = collectProtectedIds(references);

  const keep = new Set(protectedIds);
  const importedIds = new Set(references.importedIds.filter((id) => typeof id === 'string'));
  for (const record of references.importedRecords) {
    if (isPlainObject(record) && typeof record.id === 'string') importedIds.add(record.id);
  }
  const byLogicalId = {};
  const grouped = groupArtifacts(references.artifacts);
  const logicalIds = [...grouped.keys()].sort();

  for (const logicalId of logicalIds) {
    const versions = grouped.get(logicalId);
    const kept = [];
    const purged = [];
    versions.forEach((artifact, index) => {
      const retained = index < window
        || keep.has(artifact.id)
        || (keepImported && (isImportedArtifact(artifact) || importedIds.has(artifact.id)));
      if (retained) {
        keep.add(artifact.id);
        kept.push(artifact.id);
      } else {
        purged.push(artifact.id);
      }
    });
    byLogicalId[logicalId] = { keep: kept.sort(), purge: purged.sort() };
  }

  const knownIds = [...new Set(
    references.artifacts
      .filter((artifact) => isPlainObject(artifact) && typeof artifact.id === 'string')
      .map((artifact) => artifact.id),
  )];

  return {
    schema: RETENTION_SCHEMA,
    ok: true,
    keep: knownIds.filter((id) => keep.has(id)).sort(),
    purge: knownIds.filter((id) => !keep.has(id)).sort(),
    protected: [...protectedIds].sort(),
    referenced: [...referenced].sort(),
    pinned: [...pinned].sort(),
    window,
    byLogicalId,
  };
}

function invalidPlan(error) {
  return {
    schema: RETENTION_SCHEMA,
    ok: false,
    code: 'INVALID_PLAN',
    error,
    message: error,
    errors: [{ path: '/references', code: 'INVALID_PLAN', message: error }],
    removed: [],
    refused: [],
    tombstones: [],
  };
}

function invalidImport(error) {
  return {
    schema: IMPORT_SCHEMA,
    ok: false,
    code: 'IMPORT_HASH_REQUIRED',
    error,
    message: error,
    errors: [{ path: '/hashFile', code: 'IMPORT_HASH_REQUIRED', message: error }],
    imported: [],
    skipped: [],
    conflicts: [],
  };
}

function purgeId(entry) {
  if (typeof entry === 'string') return entry;
  if (isPlainObject(entry) && typeof entry.id === 'string') return entry.id;
  return null;
}

function evictionTimestamp(input) {
  if (typeof input.evictedAt === 'string' && input.evictedAt.trim() !== '') return input.evictedAt;
  if (typeof input.at === 'string' && input.at.trim() !== '') return input.at;
  if (typeof input.now === 'string' && input.now.trim() !== '') return input.now;
  if (typeof input.now === 'function') {
    const value = input.now();
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return new Date().toISOString();
}

function makeTombstone(artifact, evictedAt) {
  return {
    ...clone(artifact),
    status: 'unavailable',
    evictedAt,
    reason: 'retention',
  };
}

function sortRefused(refused) {
  return refused.sort((a, b) => {
    const idDiff = String(a.id).localeCompare(String(b.id));
    return idDiff !== 0 ? idDiff : String(a.reason).localeCompare(String(b.reason));
  });
}

export function applyRetention(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const plan = source.plan;

  if (!isPlainObject(plan) || !Array.isArray(plan.purge)) {
    return invalidPlan('plan with a purge list is required');
  }
  if (plan.schema !== undefined && plan.schema !== RETENTION_SCHEMA) {
    return invalidPlan('plan schema is not a retention plan');
  }
  if (!hasReferenceInputs(source)) {
    return invalidPlan('references required');
  }
  if (typeof source.remover !== 'function') {
    return invalidPlan('remover is required');
  }

  const references = resolveReferences(source);
  const { pinned, protectedIds } = collectProtectedIds(references);
  const pinnedArtifactIds = new Set(pinned);
  for (const artifact of references.artifacts) {
    if (!isPlainObject(artifact)) continue;
    if (pinned.has(artifact.logicalId)) pinnedArtifactIds.add(artifact.id);
  }

  const artifactsById = new Map();
  for (const artifact of references.artifacts) {
    if (isPlainObject(artifact) && typeof artifact.id === 'string') artifactsById.set(artifact.id, artifact);
  }

  const evictedAt = evictionTimestamp(source);
  const candidates = [...new Set(plan.purge.map(purgeId).filter(Boolean))].sort();
  const removed = [];
  const refused = [];
  const tombstones = [];

  const commit = (id, artifact) => {
    removed.push(id);
    tombstones.push(makeTombstone(artifact, evictedAt));
  };

  const run = (startIndex) => {
    for (let index = startIndex; index < candidates.length; index += 1) {
      const id = candidates[index];
      if (pinnedArtifactIds.has(id)) {
        refused.push({ id, reason: 'pinned' });
        continue;
      }
      if (protectedIds.has(id)) {
        refused.push({ id, reason: 'referenced' });
        continue;
      }
      const artifact = artifactsById.get(id);
      if (!artifact) {
        refused.push({ id, reason: 'missing' });
        continue;
      }

      let outcome;
      try {
        outcome = source.remover(id, artifact);
      } catch {
        refused.push({ id, reason: 'remove_failed' });
        continue;
      }

      if (isThenable(outcome)) {
        return Promise.resolve(outcome)
          .then(() => {
            commit(id, artifact);
            return run(index + 1);
          })
          .catch(() => {
            refused.push({ id, reason: 'remove_failed' });
            return run(index + 1);
          });
      }

      commit(id, artifact);
    }

    return {
      schema: RETENTION_SCHEMA,
      ok: true,
      removed: removed.sort(),
      refused: sortRefused(refused),
      tombstones: tombstones.sort((a, b) => String(a.id).localeCompare(String(b.id))),
    };
  };

  return run(0);
}

function normalizeImportInput(input, maybeOptions) {
  if (Array.isArray(input)) return { ...(isPlainObject(maybeOptions) ? maybeOptions : {}), records: input };
  return isPlainObject(input) ? input : {};
}

function existingEntries(existing) {
  if (existing === undefined || existing === null) return [];
  if (Array.isArray(existing)) return existing;
  if (existing instanceof Map) {
    return [...existing.entries()].map(([id, hash]) => (
      typeof hash === 'string' ? { id, sha256: hash } : { ...(isPlainObject(hash) ? hash : {}), id }
    ));
  }
  if (isPlainObject(existing)) {
    if (Array.isArray(existing.imported)) return existing.imported;
    return Object.entries(existing).map(([id, value]) => (
      typeof value === 'string' ? { id, sha256: value } : { ...(isPlainObject(value) ? value : {}), id }
    ));
  }
  return [];
}

function recordedHash(record) {
  if (!isPlainObject(record)) return null;
  return normalizeDigest(record.sha256 ?? record.contentHash ?? record.hash);
}

function importedProvenance(provenance) {
  if (provenance === undefined || provenance === null || provenance === '') return 'unknown';
  if (Array.isArray(provenance) && provenance.length === 0) return 'unknown';
  if (isPlainObject(provenance) && Object.keys(provenance).length === 0) return 'unknown';
  return clone(provenance);
}

function decisionIsUserAcceptance(value) {
  if (!isPlainObject(value)) return false;
  const status = value.status ?? value.state;
  if (!DECISION_ACCEPTED.has(status)) return false;
  const resolution = isPlainObject(value.resolution) ? value.resolution : {};
  const userEventId = firstDefined(value.userEventId, resolution.userEventId);
  if (typeof userEventId !== 'string' || userEventId.trim() === '') return false;
  const actor = firstDefined(resolution.actor, value.actor);
  return actor === undefined || actor === null || actor === 'user';
}

function hasHumanApproval(record, depth = 0, seen = new WeakSet()) {
  if (!isPlainObject(record) || depth > 5 || seen.has(record)) return false;
  seen.add(record);
  if (decisionIsUserAcceptance(record)) return true;

  for (const key of ['approval', 'approvalDecision', 'decision', 'humanApproval']) {
    const value = record[key];
    if (decisionIsUserAcceptance(value)) return true;
    if (isPlainObject(value) && hasHumanApproval(value, depth + 1, seen)) return true;
  }
  for (const key of ['decisions', 'provenance', 'metadata']) {
    const value = record[key];
    if (Array.isArray(value)) {
      if (value.some((entry) => hasHumanApproval(entry, depth + 1, seen))) return true;
    } else if (isPlainObject(value) && hasHumanApproval(value, depth + 1, seen)) {
      return true;
    }
  }
  return false;
}

function makeImportedRecord(record, now) {
  const imported = clone(record);
  imported.provenance = importedProvenance(record.provenance);
  imported.approval = hasHumanApproval(record) ? 'approved' : 'unknown';
  imported.imported = true;
  if (now !== undefined) {
    const stamp = typeof now === 'function' ? now() : now;
    if (typeof stamp === 'string' && stamp.trim() !== '') imported.importedAt = stamp;
  }
  return imported;
}

function sortImportResult(result) {
  result.imported.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  result.skipped.sort((a, b) => {
    const idDiff = String(a.id).localeCompare(String(b.id));
    return idDiff !== 0 ? idDiff : String(a.reason).localeCompare(String(b.reason));
  });
  result.conflicts.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return result;
}

export function planImport(input, maybeOptions) {
  const source = normalizeImportInput(input, maybeOptions);
  const records = asArray(source.records ?? source.items ?? source.artifacts);
  const hashFile = firstDefined(source.hashFile, source.hash);
  const bytesFor = firstDefined(source.bytesFor, source.readBytes);

  if (records.length === 0) {
    return sortImportResult({ schema: IMPORT_SCHEMA, ok: true, imported: [], skipped: [], conflicts: [] });
  }
  if (typeof hashFile !== 'function' && typeof bytesFor !== 'function') {
    return invalidImport('hashFile or bytesFor is required');
  }

  const existing = new Map();
  const existingSource = firstDefined(
    source.existing,
    source.existingRecords,
    source.alreadyImported,
    source.previous,
    source.imported,
  );
  for (const record of existingEntries(existingSource)) {
    if (!isPlainObject(record) || typeof record.id !== 'string') continue;
    existing.set(record.id, recordedHash(record));
  }

  const seen = new Map();
  const result = { schema: IMPORT_SCHEMA, ok: true, imported: [], skipped: [], conflicts: [] };

  const computeActual = (record) => {
    if (typeof hashFile === 'function') return hashFile(record);
    const bytes = bytesFor(record);
    if (isThenable(bytes)) {
      return Promise.resolve(bytes).then((value) => {
        const resolvedBytes = bytesFrom(value);
        return resolvedBytes ? hashBytes(resolvedBytes) : digestFromHashResult(value);
      });
    }
    const resolvedBytes = bytesFrom(bytes);
    return resolvedBytes ? hashBytes(resolvedBytes) : digestFromHashResult(bytes);
  };

  const processRecord = (record, actualValue) => {
    if (!isPlainObject(record)) {
      result.skipped.push({ id: null, reason: 'invalid_record' });
      return;
    }
    const id = typeof record.id === 'string' ? record.id : null;
    if (!id) {
      result.skipped.push({ id: null, reason: 'missing_id' });
      return;
    }

    const recorded = recordedHash(record);
    if (!recorded) {
      result.skipped.push({ id, reason: 'hash_missing' });
      return;
    }

    const actual = digestFromHashResult(actualValue);
    if (actual === null || actual === false || actual !== recorded) {
      result.skipped.push({ id, reason: 'hash_mismatch' });
      return;
    }

    if (existing.has(id)) {
      const previous = existing.get(id);
      if (previous && previous === recorded) {
        result.skipped.push({ id, reason: 'already_imported' });
      } else {
        const conflict = {
          id,
          reason: 'hash_conflict',
          existingSha256: previous ?? null,
          incomingSha256: recorded,
        };
        result.conflicts.push(conflict);
        result.skipped.push({ id, reason: 'hash_conflict' });
      }
      return;
    }

    if (seen.has(id)) {
      const previous = seen.get(id);
      if (previous === recorded) {
        result.skipped.push({ id, reason: 'already_imported' });
      } else {
        result.conflicts.push({
          id,
          reason: 'hash_conflict',
          existingSha256: previous,
          incomingSha256: recorded,
        });
        result.skipped.push({ id, reason: 'hash_conflict' });
      }
      return;
    }

    seen.set(id, recorded);
    existing.set(id, recorded);
    result.imported.push(makeImportedRecord(record, source.now));
  };

  const iterate = (startIndex) => {
    for (let index = startIndex; index < records.length; index += 1) {
      const record = records[index];
      let actual;
      try {
        actual = computeActual(record);
      } catch {
        const id = isPlainObject(record) && typeof record.id === 'string' ? record.id : null;
        result.skipped.push({ id, reason: 'hash_missing' });
        continue;
      }

      if (isThenable(actual)) {
        return Promise.resolve(actual)
          .then((value) => {
            processRecord(record, value);
            return iterate(index + 1);
          })
          .catch(() => {
            const id = isPlainObject(record) && typeof record.id === 'string' ? record.id : null;
            result.skipped.push({ id, reason: 'hash_missing' });
            return iterate(index + 1);
          });
      }

      processRecord(record, actual);
    }

    return sortImportResult(result);
  };

  return iterate(0);
}
