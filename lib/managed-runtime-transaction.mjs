import fs from "node:fs";
import path from "node:path";

const ACTIVE_NAME = "managed";
const STAGING_PREFIX = ".managed-install-";
const PREVIOUS_PREFIX = ".managed-previous-";

function isPass(result) {
  return result?.status === "PASS";
}

function assertPlainDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label}_not_plain_directory`);
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function transactionDirectories(runtimeRoot, prefix) {
  if (!fs.existsSync(runtimeRoot)) return [];
  return fs.readdirSync(runtimeRoot, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith(prefix))
    .map((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("managed_runtime_transaction_path_rejected");
      return path.join(runtimeRoot, entry.name);
    });
}

function assertStagingPath(runtimeRoot, stagingRoot) {
  const resolvedRuntime = path.resolve(runtimeRoot);
  const resolvedStaging = path.resolve(stagingRoot);
  if (path.dirname(resolvedStaging) !== resolvedRuntime || !path.basename(resolvedStaging).startsWith(STAGING_PREFIX)) throw new Error("managed_runtime_staging_path_rejected");
  assertPlainDirectory(resolvedStaging, "managed_runtime_staging");
  return resolvedStaging;
}

export function recoverManagedRuntime({ runtimeRoot, inspect, removeTree }) {
  const resolvedRuntime = path.resolve(runtimeRoot);
  const activeRoot = path.join(resolvedRuntime, ACTIVE_NAME);
  const previous = transactionDirectories(resolvedRuntime, PREVIOUS_PREFIX);
  const staging = transactionDirectories(resolvedRuntime, STAGING_PREFIX);
  if (previous.length > 1) throw new Error("multiple_managed_runtime_previous_directories");

  let action = "UNCHANGED";
  if (previous.length === 1) {
    const previousRoot = previous[0];
    const activeValid = fs.existsSync(activeRoot) && isPass(inspect(activeRoot));
    const previousValid = isPass(inspect(previousRoot));
    if (activeValid) {
      removeTree(previousRoot);
      syncDirectory(resolvedRuntime);
      action = "COMPLETED_PROMOTION_CLEANED";
    } else if (previousValid) {
      const rejectedRoot = path.join(resolvedRuntime, `.managed-rejected-${process.pid}`);
      if (fs.existsSync(rejectedRoot)) throw new Error("managed_runtime_rejected_path_exists");
      if (fs.existsSync(activeRoot)) {
        assertPlainDirectory(activeRoot, "managed_runtime_active");
        fs.renameSync(activeRoot, rejectedRoot);
      }
      fs.renameSync(previousRoot, activeRoot);
      syncDirectory(resolvedRuntime);
      if (!isPass(inspect(activeRoot))) {
        if (fs.existsSync(activeRoot)) fs.renameSync(activeRoot, previousRoot);
        if (fs.existsSync(rejectedRoot)) fs.renameSync(rejectedRoot, activeRoot);
        syncDirectory(resolvedRuntime);
        throw new Error("managed_runtime_rollback_validation_failed");
      }
      if (fs.existsSync(rejectedRoot)) removeTree(rejectedRoot);
      syncDirectory(resolvedRuntime);
      action = "ROLLED_BACK_PREVIOUS";
    } else {
      throw new Error("managed_runtime_interrupted_swap_unrecoverable");
    }
  }

  if (fs.existsSync(activeRoot)) {
    assertPlainDirectory(activeRoot, "managed_runtime_active");
    if (!isPass(inspect(activeRoot))) throw new Error("managed_runtime_active_invalid");
  }
  for (const stagingRoot of staging) removeTree(stagingRoot);
  if (staging.length > 0) syncDirectory(resolvedRuntime);
  if (staging.length > 0) action = action === "UNCHANGED" ? "DISCARDED_STALE_STAGING" : `${action}_AND_STAGING`;
  return { status: "PASS", action, active: fs.existsSync(activeRoot), discardedStaging: staging.length };
}

export function promoteManagedRuntime({ runtimeRoot, stagingRoot, inspect, removeTree, transactionId = String(process.pid), fault = () => {} }) {
  if (!/^[A-Za-z0-9._-]+$/u.test(transactionId)) throw new Error("managed_runtime_transaction_id_rejected");
  const resolvedRuntime = path.resolve(runtimeRoot);
  const activeRoot = path.join(resolvedRuntime, ACTIVE_NAME);
  const validatedStaging = assertStagingPath(resolvedRuntime, stagingRoot);
  const previousRoot = path.join(resolvedRuntime, `${PREVIOUS_PREFIX}${transactionId}`);
  if (fs.existsSync(previousRoot)) throw new Error("managed_runtime_previous_path_exists");
  if (!isPass(inspect(validatedStaging))) throw new Error("managed_runtime_staging_validation_failed");

  let previousPreserved = false;
  try {
    fault("before_swap");
    if (fs.existsSync(activeRoot)) {
      assertPlainDirectory(activeRoot, "managed_runtime_active");
      if (!isPass(inspect(activeRoot))) throw new Error("managed_runtime_active_invalid");
      fs.renameSync(activeRoot, previousRoot);
      syncDirectory(resolvedRuntime);
      previousPreserved = true;
    }
    fault("after_previous_preserved");
    fs.renameSync(validatedStaging, activeRoot);
    syncDirectory(resolvedRuntime);
    fault("after_promotion");
    if (!isPass(inspect(activeRoot))) throw new Error("managed_runtime_post_promotion_validation_failed");
    fault("after_post_validation");
    if (previousPreserved) removeTree(previousRoot);
    syncDirectory(resolvedRuntime);
    return { status: "PASS", activeRoot, previousRemoved: previousPreserved };
  } catch (error) {
    if (previousPreserved && fs.existsSync(previousRoot)) {
      const rejectedRoot = path.join(resolvedRuntime, `.managed-rejected-${transactionId}`);
      if (fs.existsSync(activeRoot)) fs.renameSync(activeRoot, rejectedRoot);
      fs.renameSync(previousRoot, activeRoot);
      syncDirectory(resolvedRuntime);
      if (!isPass(inspect(activeRoot))) throw new Error("managed_runtime_rollback_validation_failed", { cause: error });
      if (fs.existsSync(rejectedRoot)) removeTree(rejectedRoot);
      syncDirectory(resolvedRuntime);
    } else if (!previousPreserved && fs.existsSync(activeRoot) && !fs.existsSync(validatedStaging)) {
      fs.renameSync(activeRoot, validatedStaging);
      syncDirectory(resolvedRuntime);
    }
    throw error;
  }
}
