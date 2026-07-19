import { generateDeviceKeyPair } from "./auth.js";
import { KEY_RECORD_ID } from "./constants.js";

const DATABASE_NAME = "whale-buddy-live-gmv";
const DATABASE_VERSION = 1;
const KEY_STORE = "deviceKeys";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(KEY_STORE)) {
        database.createObjectStore(KEY_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("เปิดคลังกุญแจไม่สำเร็จ"));
    request.onblocked = () => reject(new Error("คลังกุญแจถูกใช้งานอยู่ กรุณาปิดหน้าเดิมแล้วลองใหม่"));
  });
}

async function withStore(mode, operation) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(KEY_STORE, mode);
      const store = transaction.objectStore(KEY_STORE);
      let result;
      try {
        result = operation(store);
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? new Error("บันทึกกุญแจไม่สำเร็จ"));
      transaction.onabort = () => reject(transaction.error ?? new Error("ยกเลิกการบันทึกกุญแจ"));
    });
  } finally {
    database.close();
  }
}

export async function getDeviceKeyPair() {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(KEY_STORE, "readonly")
        .objectStore(KEY_STORE)
        .get(KEY_RECORD_ID);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error ?? new Error("อ่านกุญแจไม่สำเร็จ"));
    });
  } finally {
    database.close();
  }
}

export async function getOrCreateDeviceKeyPair() {
  const existing = await getDeviceKeyPair();
  if (existing) {
    if (
      !(existing.privateKey instanceof CryptoKey) ||
      !(existing.publicKey instanceof CryptoKey) ||
      existing.privateKey.extractable ||
      existing.privateKey.algorithm?.name !== "ECDSA" ||
      existing.privateKey.algorithm?.namedCurve !== "P-256"
    ) {
      throw new Error("DEVICE_KEY_INVALID");
    }
    return existing;
  }

  const pair = await generateDeviceKeyPair();
  const record = {
    id: KEY_RECORD_ID,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    createdAt: new Date().toISOString()
  };
  await withStore("readwrite", (store) => store.put(record));
  return record;
}
