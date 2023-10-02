import AESCrypto from './aes-crypto';
import FastAESKey from './fast-aes-key';
import AESDecryptor, { removePadding } from './aes-decryptor';
import { logger } from '../utils/logger';
import { appendUint8Array } from '../utils/mp4-tools';
import { sliceUint8 } from '../utils/typed-array';
import type { HlsConfig } from '../config';

const CHUNK_SIZE = 16; // 16 bytes, 128 bits

export default class Decrypter {
  private logEnabled: boolean = true;
  private removePKCS7Padding: boolean;
  private subtle: SubtleCrypto | null = null;
  private softwareDecrypter: AESDecryptor | null = null;
  private key: ArrayBuffer | null = null;
  private fastAesKey: FastAESKey | null = null;
  private remainderData: Uint8Array | null = null;
  private currentIV: ArrayBuffer | null = null;
  private currentResult: ArrayBuffer | null = null;
  private useSoftware: boolean;

  constructor(config: HlsConfig, { removePKCS7Padding = true } = {}) {
    this.useSoftware = config.enableSoftwareAES;
    this.removePKCS7Padding = removePKCS7Padding;
    // built in decryptor expects PKCS7 padding
    if (removePKCS7Padding) {
      try {
        const browserCrypto = self.crypto;
        if (browserCrypto) {
          this.subtle =
            browserCrypto.subtle ||
            ((browserCrypto as any).webkitSubtle as SubtleCrypto);
        }
      } catch (e) {
        /* no-op */
      }
    }
    if (this.subtle === null) {
      this.useSoftware = true;
    }
  }

  destroy() {
    this.subtle = null;
    this.softwareDecrypter = null;
    this.key = null;
    this.fastAesKey = null;
    this.remainderData = null;
    this.currentIV = null;
    this.currentResult = null;
  }

  public isSync() {
    return this.useSoftware;
  }

  public flush(): Uint8Array | null {
    const { currentResult, remainderData } = this;
    if (!currentResult || remainderData) {
      this.reset();
      return null;
    }
    const data = new Uint8Array(currentResult);
    this.reset();
    if (this.removePKCS7Padding) {
      return removePadding(data);
    }
    return data;
  }

  public reset() {
    this.currentResult = null;
    this.currentIV = null;
    this.remainderData = null;
    if (this.softwareDecrypter) {
      this.softwareDecrypter = null;
    }
  }

  public decrypt(
    data: Uint8Array | ArrayBuffer,
    key: ArrayBuffer,
    iv: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    if (this.useSoftware) {
      return new Promise((resolve, reject) => {
        const dataView = ArrayBuffer.isView(data) ? data : new Uint8Array(data);
        this.softwareDecrypt(dataView, key, iv);
        const decryptResult = this.flush();
        if (decryptResult) {
          resolve(decryptResult.buffer);
        } else {
          reject(new Error('[softwareDecrypt] Failed to decrypt data'));
        }
      });
    }
    return this.webCryptoDecrypt(new Uint8Array(data), key, iv);
  }

  // Software decryption is progressive. Progressive decryption may not return a result on each call. Any cached
  // data is handled in the flush() call
  public softwareDecrypt(
    data: Uint8Array,
    key: ArrayBuffer,
    iv: ArrayBuffer,
  ): ArrayBuffer | null {
    const { currentIV, currentResult, remainderData } = this;
    this.logOnce('JS AES decrypt');
    // The output is staggered during progressive parsing - the current result is cached, and emitted on the next call
    // This is done in order to strip PKCS7 padding, which is found at the end of each segment. We only know we've reached
    // the end on flush(), but by that time we have already received all bytes for the segment.
    // Progressive decryption does not work with WebCrypto

    if (remainderData) {
      data = appendUint8Array(remainderData, data);
      this.remainderData = null;
    }

    // Byte length must be a multiple of 16 (AES-128 = 128 bit blocks = 16 bytes)
    const currentChunk = this.getValidChunk(data);
    if (!currentChunk.length) {
      return null;
    }

    if (currentIV) {
      iv = currentIV;
    }

    let softwareDecrypter = this.softwareDecrypter;
    if (!softwareDecrypter) {
      softwareDecrypter = this.softwareDecrypter = new AESDecryptor();
    }
    softwareDecrypter.expandKey(key);

    const result = currentResult;

    this.currentResult = softwareDecrypter.decrypt(currentChunk.buffer, 0, iv);
    this.currentIV = sliceUint8(currentChunk, -16).buffer;

    if (!result) {
      return null;
    }
    return result;
  }

  public webCryptoDecrypt(
    data: Uint8Array,
    key: ArrayBuffer,
    iv: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    const subtle = this.subtle;
    if (this.key !== key || !this.fastAesKey) {
      this.key = key;
      this.fastAesKey = new FastAESKey(subtle, key);
    }
    return this.fastAesKey
      .expandKey()
      .then((aesKey) => {
        // decrypt using web crypto
        if (!subtle) {
          return Promise.reject(new Error('web crypto not initialized'));
        }
        this.logOnce('WebCrypto AES decrypt');
        const crypto = new AESCrypto(subtle, new Uint8Array(iv));
        return crypto.decrypt(data.buffer, aesKey);
      })
      .catch((err) => {
        logger.warn(
          `[decrypter]: WebCrypto Error, disable WebCrypto API, ${err.name}: ${err.message}`,
        );

        return this.onWebCryptoError(data, key, iv);
      });
  }

  private onWebCryptoError(data, key, iv): ArrayBuffer | never {
    this.useSoftware = true;
    this.logEnabled = true;
    this.softwareDecrypt(data, key, iv);
    const decryptResult = this.flush();
    if (decryptResult) {
      return decryptResult.buffer;
    }
    throw new Error('WebCrypto and softwareDecrypt: failed to decrypt data');
  }

  private getValidChunk(data: Uint8Array): Uint8Array {
    let currentChunk = data;
    const splitPoint = data.length - (data.length % CHUNK_SIZE);
    if (splitPoint !== data.length) {
      currentChunk = sliceUint8(data, 0, splitPoint);
      this.remainderData = sliceUint8(data, splitPoint);
    }
    return currentChunk;
  }

  private logOnce(msg: string) {
    if (!this.logEnabled) {
      return;
    }
    logger.log(`[decrypter]: ${msg}`);
    this.logEnabled = false;
  }
}
