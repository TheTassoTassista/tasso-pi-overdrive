// Test-only, child-local fault injection for the existing receipt write path.
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const phase = process.env.PI_OVERDRIVE_RECEIPT_FAULT;
const marker = process.env.PI_OVERDRIVE_RECEIPT_FAULT_MARKER;
const receiptFds = new Set();
const directoryFds = new Set();
let receiptDirectory;
const active = () => phase && marker && fs.existsSync(marker);
const isReceipt = (value) => typeof value === "string" && value.includes("/pi-overdrive/edit-receipts/") && value.split("/").at(-1)?.startsWith(".receipt-");
const injected = () => {
  if (process.env.PI_OVERDRIVE_RECEIPT_FAULT_OBSERVED) fs.appendFileSync(process.env.PI_OVERDRIVE_RECEIPT_FAULT_OBSERVED, `${phase}\n`);
  return Object.assign(new Error("fixture_receipt_io_failure"), { code: "EIO" });
};
const open = fs.openSync;
const write = fs.writeFileSync;
const sync = fs.fsyncSync;
const link = fs.linkSync;
const close = fs.closeSync;
fs.openSync = function (file, ...args) {
  if (active() && isReceipt(file) && phase === "create") throw injected();
  const fd = open.call(this, file, ...args);
  if (active() && isReceipt(file)) {
    receiptFds.add(fd);
    receiptDirectory = require("node:path").dirname(file);
  }
  if (active() && phase === "dir-sync" && file === receiptDirectory) directoryFds.add(fd);
  return fd;
};
fs.writeFileSync = function (file, ...args) {
  if (active() && phase === "write" && receiptFds.has(file)) throw injected();
  return write.call(this, file, ...args);
};
fs.fsyncSync = function (fd, ...args) {
  if (active() && ((phase === "sync" && receiptFds.has(fd)) || (phase === "dir-sync" && directoryFds.has(fd)))) throw injected();
  return sync.call(this, fd, ...args);
};
fs.linkSync = function (source, target, ...args) {
  if (active() && phase === "publish" && isReceipt(source)) throw injected();
  return link.call(this, source, target, ...args);
};
fs.closeSync = function (fd, ...args) {
  receiptFds.delete(fd);
  directoryFds.delete(fd);
  return close.call(this, fd, ...args);
};
syncBuiltinESMExports();
