import fs from "node:fs";
import path from "node:path";
import { canonicalJsonSha256 } from "./canonical-json.js";
import {
  assertIdentifier,
  assertNoUnknownFields,
  assertSha256,
  failA1,
  isRecord,
  requireBoolean,
  requireFiniteNumber,
  requireInteger,
  requireString,
} from "./workflow-spec.js";
import { requireRunContract, runOwnedPath } from "./run-contract.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";

export interface ResourceAccelerator {
  model: string;
  count: number;
  memory_gb: number;
}

export interface ResourceWritablePath {
  path: string;
  capacity_bytes: number;
}

export interface ResourcePlatform {
  platform_id: string;
  access_ref: string;
  accelerators: ResourceAccelerator[];
  cpu: {
    cores: number;
    memory_gb: number;
  };
  capacity: {
    max_parallel_nodes: number;
  };
  quota: {
    amount: number;
    unit: string;
  };
  writable_paths: ResourceWritablePath[];
  network: {
    internet: boolean;
    allowed_endpoints: string[];
  };
  max_wall_clock_ms: number;
  time_window: {
    start: string;
    end: string;
  };
}

export interface ResourceInventory {
  schema_version: 1;
  inventory_id: string;
  platforms: ResourcePlatform[];
  inventory_sha256: string;
}

export interface ResourceRequest {
  platform_id: string;
  accelerator_model?: string;
  accelerator_count?: number;
  accelerator_memory_gb?: number;
  cpu_cores?: number;
  memory_gb?: number;
  writable_path?: string;
  endpoint?: string;
  wall_clock_ms?: number;
  parallel_nodes?: number;
  quota?: {
    amount: number;
    unit: string;
  };
}

export type ResourceClassificationStatus = "succeeded" | "not_executable" | "infra_unavailable";

export interface ResourceClassification {
  status: ResourceClassificationStatus;
  platform_id: string;
  reason: string;
  failure_code?: "RESOURCE_SCOPE_ALIGNMENT_REQUIRED" | "INFRA_UNAVAILABLE";
}

export type ResourceRuntimeAvailability =
  | boolean
  | { available: boolean }
  | Readonly<Record<string, boolean>>
  | ((platform: ResourcePlatform, request: ResourceRequest) => boolean);

const RESOURCE_SCHEMA = "resource-inventory-v1";

function firstProvidedField(value: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    if (Object.hasOwn(value, name) && value[name] !== undefined) return value[name];
  }
  return undefined;
}

function requireNonNegativeNumber(value: unknown, location: string): number {
  const number = requireFiniteNumber(value, location);
  if (number < 0) failA1("INVALID_VALUE", "expected a non-negative number", location);
  return number;
}

function normalizeAbsolutePath(value: unknown, location: string): string {
  const result = requireString(value, location).replaceAll("\\", "/");
  if (result.includes("\0") || !result.startsWith("/"))
    failA1("INVALID_PATH", "resource paths must be normalized absolute paths", location);
  const normalized = path.posix.normalize(result);
  if (normalized !== result || normalized === "/" || normalized.includes("/../"))
    failA1("INVALID_PATH", "resource paths must be normalized absolute paths", location);
  return normalized;
}

function normalizeTime(value: unknown, location: string): string {
  const text = requireString(value, location);
  const time = Date.parse(text);
  if (!Number.isFinite(time)) failA1("INVALID_VALUE", "time must be an ISO timestamp", location);
  return text;
}

function normalizeTimeWindow(value: unknown, location: string): ResourcePlatform["time_window"] {
  if (!isRecord(value)) failA1("INVALID_VALUE", "time_window must be an object", location);
  assertNoUnknownFields(value, ["start", "end"], location);
  const start = normalizeTime(value.start, `${location}.start`);
  const end = normalizeTime(value.end, `${location}.end`);
  if (Date.parse(start) >= Date.parse(end))
    failA1("INVALID_VALUE", "time_window.start must precede time_window.end", location);
  return { start, end };
}

function normalizeAccelerators(value: unknown, location: string): ResourceAccelerator[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) failA1("INVALID_VALUE", "accelerators must be an array", location);
  const result = value.map((item, index) => {
    const itemLocation = `${location}[${index}]`;
    if (!isRecord(item)) failA1("INVALID_VALUE", "accelerator must be an object", itemLocation);
    assertNoUnknownFields(item, ["model", "count", "memory_gb"], itemLocation);
    return {
      model: requireString(item.model, `${itemLocation}.model`),
      count: requireInteger(item.count, `${itemLocation}.count`, 1),
      memory_gb: requireNonNegativeNumber(item.memory_gb, `${itemLocation}.memory_gb`),
    };
  });
  const seen = new Set<string>();
  for (const accelerator of result) {
    if (seen.has(accelerator.model))
      failA1("DUPLICATE_ID", `accelerator model '${accelerator.model}' is repeated`, location);
    seen.add(accelerator.model);
  }
  return result;
}

function normalizeWritablePaths(value: unknown, location: string): ResourceWritablePath[] {
  if (!Array.isArray(value)) failA1("INVALID_VALUE", "writable_paths must be an array", location);
  const result = value.map((item, index) => {
    const itemLocation = `${location}[${index}]`;
    if (!isRecord(item)) failA1("INVALID_VALUE", "writable path must be an object", itemLocation);
    assertNoUnknownFields(item, ["path", "capacity_bytes"], itemLocation);
    return {
      path: normalizeAbsolutePath(item.path, `${itemLocation}.path`),
      capacity_bytes: requireInteger(item.capacity_bytes, `${itemLocation}.capacity_bytes`, 0),
    };
  });
  const seen = new Set<string>();
  for (const writable of result) {
    if (seen.has(writable.path))
      failA1("DUPLICATE_ID", `writable path '${writable.path}' is repeated`, location);
    seen.add(writable.path);
  }
  return result;
}

function normalizeEndpoints(value: unknown, location: string): string[] {
  if (!Array.isArray(value))
    failA1("INVALID_VALUE", "allowed_endpoints must be an array", location);
  const result = value.map((item, index) => requireString(item, `${location}[${index}]`));
  if (new Set(result).size !== result.length)
    failA1("DUPLICATE_ID", "allowed_endpoints must be unique", location);
  return [...result].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function normalizePlatform(value: unknown, index: number): ResourcePlatform {
  const location = `resource_inventory.platforms[${index}]`;
  if (!isRecord(value)) failA1("INVALID_VALUE", "platform must be an object", location);
  assertNoUnknownFields(
    value,
    [
      "platform_id",
      "id",
      "access_ref",
      "accelerators",
      "cpu",
      "cpu_cores",
      "memory_gb",
      "capacity",
      "max_parallel_nodes",
      "quota",
      "writable_paths",
      "network",
      "internet",
      "allowed_endpoints",
      "max_wall_clock_ms",
      "wall_clock_ms",
      "time_window",
    ],
    location,
  );
  const platformId = assertIdentifier(
    firstProvidedField(value, ["platform_id", "id"]),
    `${location}.platform_id`,
  );
  const accessRef = requireString(value.access_ref, `${location}.access_ref`);

  const cpuValue = value.cpu;
  let cpu: ResourcePlatform["cpu"];
  if (cpuValue !== undefined) {
    if (!isRecord(cpuValue)) failA1("INVALID_VALUE", "cpu must be an object", `${location}.cpu`);
    assertNoUnknownFields(cpuValue, ["cores", "memory_gb"], `${location}.cpu`);
    cpu = {
      cores: requireInteger(cpuValue.cores, `${location}.cpu.cores`, 1),
      memory_gb: requireNonNegativeNumber(cpuValue.memory_gb, `${location}.cpu.memory_gb`),
    };
  } else {
    cpu = {
      cores: requireInteger(value.cpu_cores, `${location}.cpu_cores`, 1),
      memory_gb: requireNonNegativeNumber(value.memory_gb, `${location}.memory_gb`),
    };
  }

  const capacityValue = value.capacity;
  let maxParallelNodes: number;
  if (capacityValue !== undefined) {
    if (!isRecord(capacityValue))
      failA1("INVALID_VALUE", "capacity must be an object", `${location}.capacity`);
    assertNoUnknownFields(capacityValue, ["max_parallel_nodes"], `${location}.capacity`);
    maxParallelNodes = requireInteger(
      capacityValue.max_parallel_nodes,
      `${location}.capacity.max_parallel_nodes`,
      1,
    );
  } else {
    maxParallelNodes = requireInteger(
      value.max_parallel_nodes,
      `${location}.max_parallel_nodes`,
      1,
    );
  }

  const quotaValue = value.quota;
  if (!isRecord(quotaValue))
    failA1("INVALID_VALUE", "quota must be an object", `${location}.quota`);
  assertNoUnknownFields(quotaValue, ["amount", "unit"], `${location}.quota`);
  const quota = {
    amount: requireNonNegativeNumber(quotaValue.amount, `${location}.quota.amount`),
    unit: requireString(quotaValue.unit, `${location}.quota.unit`),
  };

  const networkValue = value.network;
  let network: ResourcePlatform["network"];
  if (networkValue !== undefined) {
    if (!isRecord(networkValue))
      failA1("INVALID_VALUE", "network must be an object", `${location}.network`);
    assertNoUnknownFields(networkValue, ["internet", "allowed_endpoints"], `${location}.network`);
    network = {
      internet: requireBoolean(networkValue.internet, `${location}.network.internet`),
      allowed_endpoints: normalizeEndpoints(
        networkValue.allowed_endpoints,
        `${location}.network.allowed_endpoints`,
      ),
    };
  } else {
    network = {
      internet: requireBoolean(value.internet, `${location}.internet`),
      allowed_endpoints: normalizeEndpoints(
        value.allowed_endpoints,
        `${location}.allowed_endpoints`,
      ),
    };
  }

  const wallClock = requireInteger(
    firstProvidedField(value, ["max_wall_clock_ms", "wall_clock_ms"]),
    `${location}.max_wall_clock_ms`,
    1,
  );
  return {
    platform_id: platformId,
    access_ref: accessRef,
    accelerators: normalizeAccelerators(value.accelerators, `${location}.accelerators`),
    cpu,
    capacity: { max_parallel_nodes: maxParallelNodes },
    quota,
    writable_paths: normalizeWritablePaths(value.writable_paths, `${location}.writable_paths`),
    network,
    max_wall_clock_ms: wallClock,
    time_window: normalizeTimeWindow(value.time_window, `${location}.time_window`),
  };
}

function inventoryWithoutHash(inventory: Omit<ResourceInventory, "inventory_sha256">): object {
  return {
    schema_version: inventory.schema_version,
    inventory_id: inventory.inventory_id,
    platforms: inventory.platforms,
  };
}

function inventoryHash(inventory: Omit<ResourceInventory, "inventory_sha256">): string {
  return canonicalJsonSha256(inventoryWithoutHash(inventory), undefined, {
    schemaVersion: RESOURCE_SCHEMA,
  });
}

export function createResourceInventory(input: unknown): ResourceInventory {
  if (!isRecord(input))
    failA1("RESOURCE_INVENTORY_REQUIRED", "resource inventory must be an object");
  assertNoUnknownFields(
    input,
    ["schema_version", "inventory_id", "platforms", "resources"],
    "resource_inventory",
  );
  if (input.schema_version !== undefined && input.schema_version !== 1)
    failA1(
      "INVALID_VALUE",
      "resource inventory schema_version must be 1",
      "resource_inventory.schema_version",
    );
  const rawPlatforms = input.platforms !== undefined ? input.platforms : input.resources;
  if (!Array.isArray(rawPlatforms) || rawPlatforms.length === 0)
    failA1(
      "RESOURCE_INVENTORY_REQUIRED",
      "at least one structured platform is required",
      "resource_inventory.platforms",
    );
  const platforms = rawPlatforms.map((platform, index) => normalizePlatform(platform, index));
  if (new Set(platforms.map((platform) => platform.platform_id)).size !== platforms.length)
    failA1("DUPLICATE_ID", "resource platform ids must be unique", "resource_inventory.platforms");
  platforms.sort((left, right) =>
    Buffer.compare(Buffer.from(left.platform_id), Buffer.from(right.platform_id)),
  );
  const withoutHash = {
    schema_version: 1 as const,
    inventory_id:
      input.inventory_id === undefined
        ? "resource-inventory"
        : assertIdentifier(input.inventory_id, "resource_inventory.inventory_id"),
    platforms,
  };
  return { ...withoutHash, inventory_sha256: inventoryHash(withoutHash) };
}

export function validateResourceInventory(
  value: unknown,
  location = "resource_inventory",
): ResourceInventory {
  if (!isRecord(value))
    failA1("CORRUPT_RESOURCE_INVENTORY", "resource inventory must be an object", location);
  assertNoUnknownFields(
    value,
    ["schema_version", "inventory_id", "platforms", "inventory_sha256"],
    location,
  );
  if (value.schema_version !== 1)
    failA1(
      "CORRUPT_RESOURCE_INVENTORY",
      "resource inventory schema_version must be 1",
      `${location}.schema_version`,
    );
  if (!Object.hasOwn(value, "inventory_id"))
    failA1("CORRUPT_RESOURCE_INVENTORY", "inventory_id is required", `${location}.inventory_id`);
  const created = createResourceInventory({
    schema_version: 1,
    inventory_id: value.inventory_id,
    platforms: value.platforms,
  });
  const hash = assertSha256(value.inventory_sha256, `${location}.inventory_sha256`);
  if (hash !== created.inventory_sha256)
    failA1(
      "RESOURCE_INVENTORY_HASH_MISMATCH",
      "resource inventory hash does not match its fields",
      location,
    );
  return { ...created, inventory_sha256: hash };
}

export function resourceInventorySha256(value: unknown): string {
  return validateResourceInventory(value).inventory_sha256;
}

export function resourceInventoryPath(projectRoot: string, runId: string): string {
  return runOwnedPath(projectRoot, assertIdentifier(runId, "run_id"), "resource-inventory.json");
}

export function saveResourceInventory(
  projectRoot: string,
  runId: string,
  value: unknown,
): ResourceInventory;
export function saveResourceInventory(input: {
  project_root: string;
  run_id: string;
  inventory: unknown;
}): ResourceInventory;
export function saveResourceInventory(
  first: string | { project_root: string; run_id: string; inventory: unknown },
  second?: string,
  third?: unknown,
): ResourceInventory {
  const projectRoot = typeof first === "string" ? first : first.project_root;
  const runId = typeof first === "string" ? second : first.run_id;
  const value = typeof first === "string" ? third : first.inventory;
  if (runId === undefined) failA1("INVALID_VALUE", "run_id is required", "run_id");
  const contract = requireRunContract(projectRoot, runId);
  const inventory = validateResourceInventory(value);
  const filePath = resourceInventoryPath(projectRoot, runId);
  if (contract.run_id !== runId)
    failA1("IDENTITY_MISMATCH", "resource inventory run id mismatch", filePath);
  return withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      const existing = validateResourceInventory(readStateFile(filePath), filePath);
      if (existing.inventory_sha256 === inventory.inventory_sha256) return existing;
      failA1("IMMUTABLE_CONFLICT", "resource inventory is immutable", filePath);
    }
    writeStateJsonAtomic(filePath, inventory);
    return inventory;
  });
}

export function readResourceInventory(projectRoot: string, runId: string): ResourceInventory {
  const contract = requireRunContract(projectRoot, runId);
  const filePath = resourceInventoryPath(projectRoot, runId);
  if (!fs.existsSync(filePath))
    failA1(
      "RESOURCE_INVENTORY_NOT_FOUND",
      `resource inventory is missing at ${filePath}`,
      filePath,
    );
  const inventory = validateResourceInventory(readStateFile(filePath), filePath);
  if (contract.run_id !== runId)
    failA1("IDENTITY_MISMATCH", "resource inventory run id mismatch", filePath);
  return inventory;
}

function normalizeRequest(value: unknown): ResourceRequest {
  if (!isRecord(value)) failA1("INVALID_RESOURCE_REQUEST", "resource request must be an object");
  assertNoUnknownFields(
    value,
    [
      "platform_id",
      "accelerator_model",
      "accelerator_count",
      "accelerator_memory_gb",
      "cpu_cores",
      "memory_gb",
      "writable_path",
      "endpoint",
      "wall_clock_ms",
      "parallel_nodes",
      "quota",
    ],
    "resource_request",
  );
  const request: ResourceRequest = {
    platform_id: assertIdentifier(value.platform_id, "resource_request.platform_id"),
  };
  if (value.accelerator_model !== undefined)
    request.accelerator_model = requireString(
      value.accelerator_model,
      "resource_request.accelerator_model",
    );
  if (value.accelerator_count !== undefined)
    request.accelerator_count = requireInteger(
      value.accelerator_count,
      "resource_request.accelerator_count",
      1,
    );
  if (value.accelerator_memory_gb !== undefined)
    request.accelerator_memory_gb = requireNonNegativeNumber(
      value.accelerator_memory_gb,
      "resource_request.accelerator_memory_gb",
    );
  if (
    (request.accelerator_count !== undefined || request.accelerator_memory_gb !== undefined) &&
    request.accelerator_model === undefined
  )
    failA1(
      "INVALID_RESOURCE_REQUEST",
      "accelerator_model is required with accelerator_count or accelerator_memory_gb",
    );
  if (value.cpu_cores !== undefined)
    request.cpu_cores = requireInteger(value.cpu_cores, "resource_request.cpu_cores", 1);
  if (value.memory_gb !== undefined)
    request.memory_gb = requireNonNegativeNumber(value.memory_gb, "resource_request.memory_gb");
  if (value.writable_path !== undefined)
    request.writable_path = normalizeAbsolutePath(
      value.writable_path,
      "resource_request.writable_path",
    );
  if (value.endpoint !== undefined)
    request.endpoint = requireString(value.endpoint, "resource_request.endpoint");
  if (value.wall_clock_ms !== undefined)
    request.wall_clock_ms = requireInteger(
      value.wall_clock_ms,
      "resource_request.wall_clock_ms",
      1,
    );
  if (value.parallel_nodes !== undefined)
    request.parallel_nodes = requireInteger(
      value.parallel_nodes,
      "resource_request.parallel_nodes",
      1,
    );
  if (value.quota !== undefined) {
    if (!isRecord(value.quota))
      failA1("INVALID_RESOURCE_REQUEST", "quota must be an object", "resource_request.quota");
    assertNoUnknownFields(value.quota, ["amount", "unit"], "resource_request.quota");
    request.quota = {
      amount: requireNonNegativeNumber(value.quota.amount, "resource_request.quota.amount"),
      unit: requireString(value.quota.unit, "resource_request.quota.unit"),
    };
  }
  return request;
}

function pathMatches(inventoryPath: string, requestedPath: string): boolean {
  const base = inventoryPath.endsWith("/**") ? inventoryPath.slice(0, -3) : inventoryPath;
  const relative = path.posix.relative(base, requestedPath);
  return inventoryPath.endsWith("/**")
    ? relative === "" || (!relative.startsWith("..") && !path.posix.isAbsolute(relative))
    : relative === "";
}

function runtimeIsAvailable(
  availability: ResourceRuntimeAvailability | undefined,
  platform: ResourcePlatform,
  request: ResourceRequest,
): boolean {
  if (availability === undefined) return true;
  if (typeof availability === "boolean") return availability;
  if (typeof availability === "function") {
    let probeResult: unknown;
    try {
      probeResult = availability(platform, request);
    } catch {
      // A failed runtime probe is not proof of availability.  Keep it on the
      // explicit infra_unavailable path instead of treating the request as executable.
      return false;
    }
    return requireBoolean(probeResult, "resource_runtime.availability");
  }
  if (!isRecord(availability))
    failA1(
      "INVALID_VALUE",
      "runtime availability must be a boolean, map, or probe",
      "resource_runtime",
    );
  if (Object.hasOwn(availability, "available"))
    return requireBoolean(availability.available, "resource_runtime.available");
  return (availability as Readonly<Record<string, boolean>>)[platform.platform_id] === true;
}

function notExecutable(platformId: string, reason: string): ResourceClassification {
  return {
    status: "not_executable",
    platform_id: platformId,
    reason,
    failure_code: "RESOURCE_SCOPE_ALIGNMENT_REQUIRED",
  };
}

export function classifyResourceRequest(
  inventoryValue: unknown,
  requestValue: unknown,
  availability?: ResourceRuntimeAvailability,
): ResourceClassification {
  const inventory = validateResourceInventory(inventoryValue);
  const request = normalizeRequest(requestValue);
  const platform = inventory.platforms.find((item) => item.platform_id === request.platform_id);
  if (platform === undefined)
    return notExecutable(
      request.platform_id,
      `platform '${request.platform_id}' is outside the resource inventory`,
    );

  if (request.accelerator_model !== undefined) {
    const accelerator = platform.accelerators.find(
      (item) => item.model === request.accelerator_model,
    );
    if (
      accelerator === undefined ||
      (request.accelerator_count ?? 1) > accelerator.count ||
      (request.accelerator_memory_gb ?? 0) > accelerator.memory_gb
    )
      return notExecutable(
        request.platform_id,
        `requested accelerator is outside the resource inventory`,
      );
  }
  if (request.cpu_cores !== undefined && request.cpu_cores > platform.cpu.cores)
    return notExecutable(
      request.platform_id,
      "requested CPU capacity is outside the resource inventory",
    );
  if (request.memory_gb !== undefined && request.memory_gb > platform.cpu.memory_gb)
    return notExecutable(
      request.platform_id,
      "requested memory capacity is outside the resource inventory",
    );
  if (
    request.parallel_nodes !== undefined &&
    request.parallel_nodes > platform.capacity.max_parallel_nodes
  )
    return notExecutable(
      request.platform_id,
      "requested parallel capacity is outside the resource inventory",
    );
  if (request.wall_clock_ms !== undefined && request.wall_clock_ms > platform.max_wall_clock_ms)
    return notExecutable(
      request.platform_id,
      "requested wall-clock limit is outside the resource inventory",
    );
  if (
    request.writable_path !== undefined &&
    !platform.writable_paths.some((item) => pathMatches(item.path, request.writable_path!))
  )
    return notExecutable(
      request.platform_id,
      "requested writable path is outside the resource inventory",
    );
  if (request.endpoint !== undefined) {
    if (
      !platform.network.internet ||
      !platform.network.allowed_endpoints.includes(request.endpoint)
    )
      return notExecutable(
        request.platform_id,
        "requested endpoint is outside the resource inventory",
      );
  }
  if (request.quota !== undefined) {
    if (request.quota.unit !== platform.quota.unit || request.quota.amount > platform.quota.amount)
      return notExecutable(
        request.platform_id,
        "requested quota is outside the resource inventory",
      );
  }
  if (!runtimeIsAvailable(availability, platform, request))
    return {
      status: "infra_unavailable",
      platform_id: request.platform_id,
      reason: "the requested platform is declared but unavailable at runtime",
      failure_code: "INFRA_UNAVAILABLE",
    };
  return {
    status: "succeeded",
    platform_id: request.platform_id,
    reason: "resource request is executable",
  };
}

export const checkResourceRequest = classifyResourceRequest;
export const classifyResourceAvailability = classifyResourceRequest;

export function assertResourceRequestExecutable(
  inventoryValue: unknown,
  requestValue: unknown,
  availability?: ResourceRuntimeAvailability,
): ResourceClassification {
  const result = classifyResourceRequest(inventoryValue, requestValue, availability);
  if (result.status !== "succeeded") failA1(result.failure_code!, result.reason);
  return result;
}

export const resourceInventoryHash = resourceInventorySha256;
