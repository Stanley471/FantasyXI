import crypto from "crypto";

/**
 * A software WebAuthn authenticator for tests. It creates real ES256 (P-256)
 * credentials, "none" attestation objects and ECDSA assertion signatures, so
 * the server-side verification under test runs exactly as it would against a
 * phone or security key.
 */

type CborValue = number | string | Uint8Array | CborValue[] | Map<CborValue, CborValue> | { [key: string]: CborValue };

function cborHead(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  if (length < 0x10000) return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(length, 1);
  return out;
}

/** Minimal canonical CBOR encoder (integers, byte/text strings, arrays, maps). */
export function cborEncode(value: CborValue): Buffer {
  if (typeof value === "number") {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) {
    return Buffer.concat([cborHead(2, value.length), Buffer.from(value)]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([cborHead(4, value.length), ...value.map(cborEncode)]);
  }
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return Buffer.concat([
    cborHead(5, entries.length),
    ...entries.flatMap(([k, v]) => [cborEncode(k as CborValue), cborEncode(v)]),
  ]);
}

const b64url = (data: Uint8Array | string) => Buffer.from(data).toString("base64url");
const sha256 = (data: Uint8Array | string) => crypto.createHash("sha256").update(data).digest();

export interface SoftCredential {
  id: Buffer;
  privateKey: crypto.KeyObject;
  cosePublicKey: Buffer;
  counter: number;
}

export interface AssertionOverrides {
  /** Sign with this counter instead of incrementing (e.g. to simulate a cloned key) */
  counter?: number;
  origin?: string;
  rpId?: string;
  userVerified?: boolean;
  /** Mutate the signed bytes after signing to simulate tampering */
  tamper?: "signature" | "authenticatorData" | "clientData";
}

export class SoftAuthenticator {
  public readonly credentials: SoftCredential[] = [];

  constructor(
    private readonly origin: string,
    private readonly rpId: string,
    private readonly transports: string[] = ["internal"]
  ) {}

  private createCredential(startCounter: number): SoftCredential {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const cose = new Map<CborValue, CborValue>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]);
    const credential = {
      id: crypto.randomBytes(32),
      privateKey,
      cosePublicKey: cborEncode(cose),
      counter: startCounter,
    };
    this.credentials.push(credential);
    return credential;
  }

  /** Answers navigator.credentials.create() for the given server options. */
  public register(options: { challenge: string; rp: { id?: string } }, startCounter = 0) {
    const credential = this.createCredential(startCounter);
    const clientDataJSON = JSON.stringify({
      type: "webauthn.create",
      challenge: options.challenge,
      origin: this.origin,
      crossOrigin: false,
    });
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(credential.counter);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(credential.id.length);
    const authData = Buffer.concat([
      sha256(options.rp.id ?? this.rpId),
      Buffer.from([0x45]), // user present + user verified + attested credential data
      counter,
      Buffer.alloc(16), // AAGUID
      idLength,
      credential.id,
      credential.cosePublicKey,
    ]);
    const attestationObject = cborEncode({ fmt: "none", attStmt: {}, authData });

    return {
      credential,
      response: {
        id: b64url(credential.id),
        rawId: b64url(credential.id),
        type: "public-key" as const,
        response: {
          clientDataJSON: b64url(clientDataJSON),
          attestationObject: b64url(attestationObject),
          transports: this.transports as any,
        },
        clientExtensionResults: {},
      },
    };
  }

  /** Answers navigator.credentials.get() with `credential` for the given challenge. */
  public assert(challenge: string, credential: SoftCredential, overrides: AssertionOverrides = {}) {
    if (overrides.counter === undefined) credential.counter += 1;
    const signCount = overrides.counter ?? credential.counter;

    const clientDataJSON = JSON.stringify({
      type: "webauthn.get",
      challenge,
      origin: overrides.origin ?? this.origin,
      crossOrigin: false,
    });
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(signCount);
    const flags = overrides.userVerified === false ? 0x01 : 0x05;
    let authenticatorData = Buffer.concat([sha256(overrides.rpId ?? this.rpId), Buffer.from([flags]), counter]);
    let signature = crypto.sign(
      "sha256",
      Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
      credential.privateKey
    );
    let clientData = clientDataJSON;

    if (overrides.tamper === "signature") {
      signature = Buffer.from(signature);
      signature[signature.length - 1] ^= 0xff;
    } else if (overrides.tamper === "authenticatorData") {
      authenticatorData = Buffer.from(authenticatorData);
      authenticatorData.writeUInt32BE(signCount + 1000, 33);
    } else if (overrides.tamper === "clientData") {
      clientData = clientDataJSON.replace('"crossOrigin":false', '"crossOrigin":false,"extra":"x"');
    }

    return {
      id: b64url(credential.id),
      rawId: b64url(credential.id),
      type: "public-key" as const,
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
      },
      clientExtensionResults: {},
    };
  }
}
