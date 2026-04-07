const { STORAGE_KEYS, get, set } = require("../../utils/storage");

let _intakesCache = null;
let _intakeCacheExpireAt = 0;

const INTAKES_CACHE_TTL_MS = 5 * 60 * 1000;

function nowISOTime() {
  return new Date().toISOString();
}

function isCacheValid() {
  return _intakesCache && Date.now() < _intakeCacheExpireAt;
}

function getIntakes({ userId, status = "submitted" } = {}) {
  if (isCacheValid()) {
    let result = _intakesCache;
    if (userId) {
      result = result.filter((item) => item.user_id === userId);
    }
    if (status) {
      result = result.filter((item) => item.status === status);
    }
    return {
      status: "success",
      data: result,
      source: "memory"
    };
  }

  try {
    const intakes = get(STORAGE_KEYS.BUYER_INTAKES, []);
    if (Array.isArray(intakes)) {
      _intakesCache = intakes;
      _intakeCacheExpireAt = Date.now() + INTAKES_CACHE_TTL_MS;

      let result = intakes;
      if (userId) {
        result = result.filter((item) => item.user_id === userId);
      }
      if (status) {
        result = result.filter((item) => item.status === status);
      }

      return {
        status: "success",
        data: result,
        source: "storage"
      };
    }
  } catch (err) {
    console.warn("[userState.intakeRepo] getIntakes failed", err);
  }

  return {
    status: "success",
    data: [],
    source: "none"
  };
}

function getIntake(intakeId) {
  const result = getIntakes();
  if (result.status !== "success") {
    return result;
  }

  const intake = result.data.find((item) => item.intake_id === intakeId);
  return {
    status: intake ? "success" : "not_found",
    data: intake || null
  };
}

function upsertIntake(intake) {
  try {
    const result = getIntakes({ status: null });
    const intakes = result.data || [];
    const now = nowISOTime();
    const intakeId = intake.intake_id || `intake_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const existing = intakes.findIndex((item) => item.intake_id === intakeId);

    let updated;
    if (existing >= 0) {
      updated = {
        ...intakes[existing],
        ...intake,
        intake_id: intakeId,
        updated_at: now,
        version: String(parseInt(intakes[existing].version || "0", 10) + 1)
      };
      intakes[existing] = updated;
    } else {
      updated = {
        intake_id: intakeId,
        status: "draft",
        created_at: now,
        updated_at: now,
        version: "1",
        ...intake
      };
      intakes.push(updated);
    }

    set(STORAGE_KEYS.BUYER_INTAKES, intakes);
    _intakesCache = intakes;
    _intakeCacheExpireAt = Date.now() + INTAKES_CACHE_TTL_MS;

    return {
      status: "success",
      data: updated
    };
  } catch (err) {
    return {
      status: "error",
      error: err.message
    };
  }
}

function updateIntakeStatus(intakeId, newStatus) {
  try {
    const result = getIntakes({ status: null });
    const intakes = result.data || [];
    const intake = intakes.find((item) => item.intake_id === intakeId);
    if (!intake) {
      return {
        status: "not_found"
      };
    }

    const updated = {
      ...intake,
      status: newStatus,
      updated_at: nowISOTime(),
      version: String(parseInt(intake.version || "0", 10) + 1)
    };

    intakes[intakes.indexOf(intake)] = updated;

    set(STORAGE_KEYS.BUYER_INTAKES, intakes);
    _intakesCache = intakes;
    _intakeCacheExpireAt = Date.now() + INTAKES_CACHE_TTL_MS;

    return {
      status: "success",
      data: updated
    };
  } catch (err) {
    return {
      status: "error",
      error: err.message
    };
  }
}

function deleteIntake(intakeId) {
  try {
    const result = getIntakes({ status: null });
    const intakes = result.data || [];
    const filtered = intakes.filter((item) => item.intake_id !== intakeId);

    set(STORAGE_KEYS.BUYER_INTAKES, filtered);
    _intakesCache = filtered;
    _intakeCacheExpireAt = Date.now() + INTAKES_CACHE_TTL_MS;

    return {
      status: "success",
      deleted: true
    };
  } catch (err) {
    return {
      status: "error",
      error: err.message
    };
  }
}

function updateIntakes(intakes) {
  try {
    const normalized = Array.isArray(intakes) ? intakes : [];
    const withVersion = normalized.map((item) => ({
      ...item,
      version: item.version || "1",
      updated_at: item.updated_at || nowISOTime()
    }));

    set(STORAGE_KEYS.BUYER_INTAKES, withVersion);
    _intakesCache = withVersion;
    _intakeCacheExpireAt = Date.now() + INTAKES_CACHE_TTL_MS;

    return {
      status: "success",
      count: withVersion.length
    };
  } catch (err) {
    return {
      status: "error",
      error: err.message
    };
  }
}

function invalidateCache() {
  _intakesCache = null;
  _intakeCacheExpireAt = 0;
}

module.exports = {
  getIntakes,
  getIntake,
  upsertIntake,
  updateIntakeStatus,
  deleteIntake,
  updateIntakes,
  invalidateCache
};
