\
import pg from "pg";
import crypto from "node:crypto";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 3,
});
const GROUPS = ["A+","A-","B+","B-","AB+","AB-","O+","O-"];
const SECRET = process.env.SESSION_SECRET;
const cookieName = "bb_session";

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("hex");
}
function sign(value) {
  return crypto.createHmac("sha256", SECRET).update(value).digest("hex");
}
function makeToken(name) {
  const payload = Buffer.from(JSON.stringify({name, exp: Date.now()+7*24*60*60*1000})).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
function readToken(event) {
  const cookies = event.headers.cookie || event.headers.Cookie || "";
  const raw = cookies.split(";").map(x=>x.trim()).find(x=>x.startsWith(cookieName+"="))?.slice(cookieName.length+1);
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(payload)))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload,"base64url").toString());
    return data.exp > Date.now() ? data.name : null;
  } catch { return null; }
}
const cookie = (value, maxAge=604800) => `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const json = (statusCode, body, headers={}) => ({
  statusCode, headers: {"Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store", ...headers},
  body: JSON.stringify(body)
});
const fail = (message, status=400) => { const e=new Error(message); e.status=status; throw e; };
const need = (b,k) => { const v=String(b?.[k] ?? "").trim(); if(!v) fail(`${k.replaceAll("_"," ")} is required`); return v; };
const validDate = (b,k) => { const v=need(b,k); if(!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) fail("Use a real date in YYYY-MM-DD format"); return v; };
const group = b => { const g=need(b,"blood_group").toUpperCase(); if(!GROUPS.includes(g)) fail("Invalid blood group"); return g; };
const bodyOf = event => { try { return event.body ? JSON.parse(event.body) : {}; } catch { fail("Invalid JSON"); } };

async function init(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS donors(donor_id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS hospitals(hospital_id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS requests(
      request_id TEXT PRIMARY KEY, hospital_id BIGINT NOT NULL REFERENCES hospitals(hospital_id),
      blood_group TEXT NOT NULL CHECK(blood_group = ANY(ARRAY['A+','A-','B+','B-','AB+','AB-','O+','O-'])),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSED','CANCELLED'))
    );
    CREATE TABLE IF NOT EXISTS blood_units(
      unit_id TEXT PRIMARY KEY,
      blood_group TEXT NOT NULL CHECK(blood_group = ANY(ARRAY['A+','A-','B+','B-','AB+','AB-','O+','O-'])),
      donor_id BIGINT NOT NULL REFERENCES donors(donor_id),
      expiry DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK(status IN ('AVAILABLE','ISSUED','EXPIRED')),
      request_id TEXT REFERENCES requests(request_id)
    );
    CREATE TABLE IF NOT EXISTS users(
      user_id BIGSERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL,
      salt TEXT NOT NULL, pw_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history(id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), message TEXT NOT NULL);
  `);
  const count = await db.query("SELECT COUNT(*)::int AS n FROM blood_units");
  if (count.rows[0].n === 0) {
    await db.query("INSERT INTO donors(name) VALUES($1) ON CONFLICT(name) DO NOTHING",["Nikshita"]);
    const d=await db.query("SELECT donor_id FROM donors WHERE name=$1",["Nikshita"]);
    await db.query("INSERT INTO blood_units(unit_id,blood_group,donor_id,expiry) VALUES('1001','O-',$1,'2027-04-28') ON CONFLICT DO NOTHING",[d.rows[0].donor_id]);
    await db.query("INSERT INTO hospitals(name) VALUES($1) ON CONFLICT(name) DO NOTHING",["XYZ hospital"]);
    const h=await db.query("SELECT hospital_id FROM hospitals WHERE name=$1",["XYZ hospital"]);
    await db.query("INSERT INTO requests(request_id,hospital_id,blood_group,quantity) VALUES('101',$1,'O-',2) ON CONFLICT DO NOTHING",[h.rows[0].hospital_id]);
  }
}
async function nameId(db, table, idCol, name) {
  const allowed = {donors:["donors","donor_id"], hospitals:["hospitals","hospital_id"]};
  const [t,c]=allowed[table] || [];
  if(!t) fail("Invalid table");
  await db.query(`INSERT INTO ${t}(name) VALUES($1) ON CONFLICT(name) DO NOTHING`,[name]);
  const r=await db.query(`SELECT ${c} FROM ${t} WHERE name=$1`,[name]);
  return r.rows[0][c];
}
async function log(db,msg){ await db.query("INSERT INTO history(message) VALUES($1)",[msg]); }

async function route(db, method, path, b, query) {
  const p=path.replace(/^\/api\/?/,"").split("/").filter(Boolean);
  if(p.length===1 && p[0]==="units" && method==="GET"){
    return (await db.query(`SELECT u.unit_id,u.blood_group,d.name AS donor,to_char(u.expiry,'YYYY-MM-DD') AS expiry,u.status
      FROM blood_units u JOIN donors d ON d.donor_id=u.donor_id ORDER BY u.unit_id`)).rows;
  }
  if(p.length===1 && p[0]==="units" && method==="POST"){
    const uid=need(b,"unit_id"),g=group(b),exp=validDate(b,"expiry"),did=await nameId(db,"donors","donor_id",need(b,"donor"));
    await db.query("INSERT INTO blood_units(unit_id,blood_group,donor_id,expiry) VALUES($1,$2,$3,$4)",[uid,g,did,exp]);
    await log(db,`ADDED unit ${uid} (${g})`); return {ok:"Blood unit added"};
  }
  if(p[0]==="units" && p.length===2 && method==="PUT"){
    const r=await db.query("SELECT status FROM blood_units WHERE unit_id=$1",[p[1]]);
    if(!r.rowCount) fail("Unit not found");
    if(r.rows[0].status!=="AVAILABLE") fail("Only AVAILABLE units can be updated");
    if(b.donor) await db.query("UPDATE blood_units SET donor_id=$1 WHERE unit_id=$2",[await nameId(db,"donors","donor_id",b.donor.trim()),p[1]]);
    if(b.expiry) await db.query("UPDATE blood_units SET expiry=$1 WHERE unit_id=$2",[validDate(b,"expiry"),p[1]]);
    await log(db,`UPDATED unit ${p[1]}`); return {ok:"Unit updated"};
  }
  if(p[0]==="units" && p.length===2 && method==="DELETE"){
    const r=await db.query("SELECT status FROM blood_units WHERE unit_id=$1",[p[1]]);
    if(!r.rowCount) fail("Unit not found");
    if(r.rows[0].status==="ISSUED") fail("Issued units are part of the records and cannot be deleted");
    await db.query("DELETE FROM blood_units WHERE unit_id=$1",[p[1]]); await log(db,`DELETED unit ${p[1]}`);
    return {ok:"Unit deleted"};
  }
  if(p.length===1 && p[0]==="requests" && method==="GET"){
    return (await db.query(`SELECT r.request_id,h.name AS hospital,r.blood_group,r.quantity,r.status
      FROM requests r JOIN hospitals h ON h.hospital_id=r.hospital_id ORDER BY r.request_id`)).rows;
  }
  if(p.length===1 && p[0]==="requests" && method==="POST"){
    const rid=need(b,"request_id"),g=group(b); const qty=Number(b.quantity);
    if(!Number.isInteger(qty) || qty<=0) fail("Quantity must be a positive whole number");
    const hid=await nameId(db,"hospitals","hospital_id",need(b,"hospital"));
    await db.query("INSERT INTO requests(request_id,hospital_id,blood_group,quantity) VALUES($1,$2,$3,$4)",[rid,hid,g,qty]);
    await log(db,`REGISTERED request ${rid}`); return {ok:"Request registered"};
  }
  if(p[0]==="requests" && p.length===3 && p[2]==="process" && method==="POST"){
    const r=await db.query("SELECT * FROM requests WHERE request_id=$1 FOR UPDATE",[p[1]]);
    if(!r.rowCount) fail("Request not found");
    const req=r.rows[0]; if(req.status!=="PENDING") fail(`Request is ${req.status}`);
    const today=validDate(b,"today");
    const units=await db.query(`SELECT unit_id FROM blood_units WHERE blood_group=$1 AND status='AVAILABLE' AND expiry >= $2
      ORDER BY expiry LIMIT $3 FOR UPDATE`,[req.blood_group,today,req.quantity]);
    if(units.rowCount<req.quantity) fail(`Not enough stock: only ${units.rowCount} matching unit(s) available`);
    for(const u of units.rows){ await db.query("UPDATE blood_units SET status='ISSUED',request_id=$1 WHERE unit_id=$2",[p[1],u.unit_id]); await log(db,`ISSUED unit ${u.unit_id} for request ${p[1]}`); }
    await db.query("UPDATE requests SET status='PROCESSED' WHERE request_id=$1",[p[1]]);
    return {ok:`Issued ${units.rowCount} unit(s): ${units.rows.map(x=>x.unit_id).join(", ")}. Exact group match only; compatibility must be verified by medical staff.`};
  }
  if(p[0]==="requests" && p.length===3 && p[2]==="cancel" && method==="POST"){
    const r=await db.query("SELECT status FROM requests WHERE request_id=$1",[p[1]]);
    if(!r.rowCount) fail("Request not found"); if(r.rows[0].status!=="PENDING") fail("Only PENDING requests can be cancelled");
    await db.query("UPDATE requests SET status='CANCELLED' WHERE request_id=$1",[p[1]]); await log(db,`CANCELLED request ${p[1]}`);
    return {ok:"Request cancelled"};
  }
  if(p.length===1 && p[0]==="expiry" && method==="GET"){
    const today=validDate({t:query.get("today")||""},"t");
    return (await db.query("SELECT unit_id,blood_group,to_char(expiry,'YYYY-MM-DD') AS expiry FROM blood_units WHERE status='AVAILABLE' AND expiry <= $1 ORDER BY expiry",[today])).rows;
  }
  if(p.length===1 && p[0]==="expiry" && method==="POST"){
    const today=validDate(b,"today");
    const r=await db.query("SELECT unit_id FROM blood_units WHERE status='AVAILABLE' AND expiry <= $1",[today]);
    for(const u of r.rows){ await db.query("UPDATE blood_units SET status='EXPIRED' WHERE unit_id=$1",[u.unit_id]); await log(db,`EXPIRED unit ${u.unit_id}`); }
    return {ok:"Expired units marked"};
  }
  if(p.length===1 && p[0]==="shortage"){
    const r=await db.query("SELECT blood_group,COUNT(*)::int AS available FROM blood_units WHERE status='AVAILABLE' GROUP BY blood_group");
    const counts=Object.fromEntries(r.rows.map(x=>[x.blood_group,x.available]));
    return GROUPS.map(g=>({blood_group:g,available:counts[g]||0}));
  }
  if(p.length===1 && p[0]==="history"){
    return (await db.query("SELECT to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS') AS at,message FROM history ORDER BY id DESC")).rows;
  }
  if(p.length===1 && p[0]==="analytics"){
    const units=(await db.query("SELECT status,COUNT(*)::int AS n FROM blood_units GROUP BY status")).rows;
    const requests=(await db.query("SELECT status,COUNT(*)::int AS n FROM requests GROUP BY status")).rows;
    const hospitals=(await db.query(`SELECT h.name,COUNT(r.request_id)::int AS requests,COALESCE(SUM(r.quantity),0)::int AS units
      FROM requests r JOIN hospitals h ON h.hospital_id=r.hospital_id GROUP BY h.hospital_id ORDER BY units DESC`)).rows;
    return {units,requests,hospitals};
  }
  fail("Unknown endpoint",404);
}

export const handler = async (event) => {
  if (!process.env.DATABASE_URL || !SECRET) return json(500,{error:"Deployment setup incomplete: DATABASE_URL and SESSION_SECRET are required"});
  const path = (event.path || event.rawUrl || "/").replace(/^\/\.netlify\/functions\/api/,"/api");
  const method=event.httpMethod || "GET";
  const b=bodyOf(event);
  const db=await pool.connect();
  try {
    await db.query("BEGIN");
    await init(db);
    if(path==="/api/signup" || path==="/api/login"){
      const username=need(b,"username").toLowerCase(), password=String(b.password||"");
      let name;
      if(path==="/api/signup"){
        name=need(b,"name");
        if(username.length<3 || password.length<6) fail("Username needs 3+ characters and password 6+");
        const salt=crypto.randomBytes(16).toString("hex");
        await db.query("INSERT INTO users(username,full_name,salt,pw_hash) VALUES($1,$2,$3,$4)",[username,name,salt,hashPassword(password,Buffer.from(salt,"hex"))]);
      } else {
        const r=await db.query("SELECT * FROM users WHERE username=$1",[username]);
        if(!r.rowCount || !crypto.timingSafeEqual(Buffer.from(r.rows[0].pw_hash),Buffer.from(hashPassword(password,Buffer.from(r.rows[0].salt,"hex"))))) fail("Invalid username or password",401);
        name=r.rows[0].full_name;
      }
      await db.query("COMMIT");
      return json(200,{ok:"Welcome, "+name,name},{ "Set-Cookie":cookie(makeToken(name)) });
    }
    if(path==="/api/logout"){
      await db.query("COMMIT");
      return json(200,{ok:"Logged out"},{ "Set-Cookie":cookie("",0) });
    }
    const who=readToken(event);
    if(!who) fail("Please log in",401);
    if(path==="/api/me"){ await db.query("COMMIT"); return json(200,{name:who}); }
    const url=new URL(event.rawUrl || `https://netlify.local${path}`);
    const result=await route(db,method,path,b,url.searchParams);
    await db.query("COMMIT");
    return json(200,result);
  } catch(e) {
    try { await db.query("ROLLBACK"); } catch {}
    const code=e.status || (e.code==="23505" ? 400 : 500);
    const message=e.code==="23505" ? "That ID/name already exists" : (e.code==="23503" || e.code==="23514" ? "Rejected by a database constraint" : e.message || "Server error");
    return json(code,{error:message});
  } finally { db.release(); }
};
