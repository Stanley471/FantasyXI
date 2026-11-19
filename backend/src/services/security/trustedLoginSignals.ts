import { BlockList, isIP } from "node:net";
import type { Request } from "express";
import { locateFromHeaders } from "./geoVelocity.js";

/** Forwarded geo/ASN/client-IP evidence is accepted only from configured peers. */
export function trustedLoginSignals(req: Pick<Request,"ip"|"socket"|"headers">) {
  const peer=(req.socket.remoteAddress ?? "").replace(/^::ffff:/,"");
  const peers=new BlockList();
  for(const entry of (process.env.LOGIN_TRUSTED_PROXY_CIDRS ?? "").split(",").map(x=>x.trim()).filter(Boolean)) {
    const [ip,prefix]=entry.split("/"); const family=isIP(ip);
    if(!family) throw new Error("Invalid login proxy configuration");
    if(prefix===undefined) peers.addAddress(ip,family===4?"ipv4":"ipv6");
    else peers.addSubnet(ip,Number(prefix),family===4?"ipv4":"ipv6");
  }
  const trusted=!!isIP(peer) && peers.check(peer,isIP(peer)===4?"ipv4":"ipv6");
  if(process.env.GEOIP_HEADER_SOURCE && !trusted) throw new Error("Login location evidence requires a trusted proxy");
  const header=process.env.LOGIN_ASN_HEADER?.toLowerCase();
  const raw=trusted && header ? req.headers[header] : undefined;
  const asn=typeof raw==="string" && /^(?:AS)?\d{1,10}$/.test(raw) && Number(raw.replace(/^AS/,""))<=4294967295 ? raw.replace(/^AS/,"") : null;
  const location=trusted?locateFromHeaders(req.headers):null;
  if(process.env.GEOIP_HEADER_SOURCE && !location) throw new Error("Login location evidence unavailable");
  return {ip:trusted?(req.ip ?? peer):peer || "unknown",asn,location};
}
