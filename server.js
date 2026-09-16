import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieSession from 'cookie-session';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const app=express();
const PORT=process.env.PORT||3000;
const ADMIN_USER=process.env.ADMIN_USER||'admin';
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD;
if(!ADMIN_PASSWORD){ console.warn('Set ADMIN_PASSWORD before production use.'); }

const db=new Database(process.env.DB_PATH||path.join(__dirname,'data.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,phone TEXT UNIQUE,email TEXT UNIQUE,password_hash TEXT NOT NULL,balance_kobo INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS prizes(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,amount_kobo INTEGER NOT NULL DEFAULT 0,weight INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,prize_id INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'issued',issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,revealed_at TEXT,FOREIGN KEY(user_id) REFERENCES users(id),FOREIGN KEY(prize_id) REFERENCES prizes(id));
CREATE TABLE IF NOT EXISTS withdrawals(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,amount_kobo INTEGER NOT NULL,bank_name TEXT NOT NULL,account_name TEXT NOT NULL,account_number TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,processed_at TEXT,FOREIGN KEY(user_id) REFERENCES users(id));
`);
const count=db.prepare('SELECT COUNT(*) c FROM prizes').get().c;
if(count===0){
 const ins=db.prepare('INSERT INTO prizes(name,amount_kobo,weight) VALUES(?,?,?)');
 for(const p of [['₦100',10000,35],['₦500',50000,25],['₦1,000',100000,15],['Free Data',0,15],['Try Again',0,8],['JACKPOT',500000,2]]) ins.run(...p);
}

app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:'50kb'}));
app.use(cookieSession({name:'sp_session',keys:[process.env.SESSION_SECRET||'CHANGE_ME_LONG_RANDOM_SECRET'],httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:1000*60*60*24*7}));
app.use(rateLimit({windowMs:60*1000,max:120,standardHeaders:true,legacyHeaders:false}));

const auth=(req,res,next)=>{ if(!req.session?.userId) return res.status(401).json({error:'Login required'}); next(); };
const admin=(req,res,next)=>{ if(!req.session?.admin) return res.status(403).json({error:'Admin access required'}); next(); };
const naira=k=>`₦${(k/100).toLocaleString('en-NG')}`;
function pickPrize(){
 const rows=db.prepare('SELECT * FROM prizes WHERE active=1 AND weight>0').all();
 const total=rows.reduce((s,p)=>s+p.weight,0); if(!total) throw new Error('No active prize weights configured');
 let r=crypto.randomInt(1,total+1);
 for(const p of rows){ r-=p.weight; if(r<=0) return p; }
 return rows[rows.length-1];
}

app.post('/api/auth/register',async(req,res)=>{
 const {name,phone,email,password}=req.body||{};
 if(!name||!phone||!password||password.length<8) return res.status(400).json({error:'Name, phone and a password of at least 8 characters are required'});
 try{ const hash=await bcrypt.hash(password,12); const info=db.prepare('INSERT INTO users(name,phone,email,password_hash) VALUES(?,?,?,?)').run(name.trim(),phone.trim(),email?.trim()||null,hash); req.session.userId=info.lastInsertRowid; res.json({ok:true}); }
 catch(e){res.status(400).json({error:'Phone or email already registered'});}
});
app.post('/api/auth/login',async(req,res)=>{
 const {phone,password}=req.body||{}; const u=db.prepare('SELECT * FROM users WHERE phone=?').get(phone||'');
 if(!u||!(await bcrypt.compare(password||'',u.password_hash))) return res.status(401).json({error:'Invalid login'});
 req.session.userId=u.id; res.json({ok:true});
});
app.post('/api/auth/logout',(req,res)=>{req.session=null;res.json({ok:true})});
app.get('/api/me',auth,(req,res)=>{const u=db.prepare('SELECT id,name,phone,email,balance_kobo FROM users WHERE id=?').get(req.session.userId);res.json({...u,balance:naira(u.balance_kobo)});});

app.post('/api/game/card',auth,(req,res)=>{
 const prize=pickPrize(); const id=crypto.randomUUID();
 db.prepare('INSERT INTO cards(id,user_id,prize_id) VALUES(?,?,?)').run(id,req.session.userId,prize.id);
 res.json({cardId:id});
});
app.post('/api/game/reveal',auth,(req,res)=>{
 const card=db.prepare(`SELECT c.*,p.name,p.amount_kobo FROM cards c JOIN prizes p ON p.id=c.prize_id WHERE c.id=? AND c.user_id=?`).get(req.body?.cardId,req.session.userId);
 if(!card) return res.status(404).json({error:'Card not found'});
 if(card.status!=='issued') return res.status(400).json({error:'Card already revealed'});
 const tx=db.transaction(()=>{
   db.prepare('UPDATE cards SET status="revealed",revealed_at=CURRENT_TIMESTAMP WHERE id=?').run(card.id);
   if(card.amount_kobo>0) db.prepare('UPDATE users SET balance_kobo=balance_kobo+? WHERE id=?').run(card.amount_kobo,req.session.userId);
 }); tx();
 res.json({prize:card.name,amount:naira(card.amount_kobo)});
});

app.post('/api/withdrawals',auth,(req,res)=>{
 const {amount_kobo,bank_name,account_name,account_number}=req.body||{}; const amount=Number(amount_kobo);
 if(!Number.isInteger(amount)||amount<10000) return res.status(400).json({error:'Minimum withdrawal is ₦100'});
 if(!bank_name||!account_name||!/^[0-9]{10}$/.test(account_number||'')) return res.status(400).json({error:'Valid bank details are required'});
 const result=db.transaction(()=>{
   const u=db.prepare('SELECT balance_kobo FROM users WHERE id=?').get(req.session.userId);
   if(!u||u.balance_kobo<amount) throw new Error('Insufficient balance');
   db.prepare('UPDATE users SET balance_kobo=balance_kobo-? WHERE id=?').run(amount,req.session.userId);
   return db.prepare('INSERT INTO withdrawals(user_id,amount_kobo,bank_name,account_name,account_number) VALUES(?,?,?,?,?)').run(req.session.userId,amount,bank_name,account_name,account_number);
 })();
 res.json({ok:true,id:result.lastInsertRowid,status:'pending'});
});
app.get('/api/withdrawals',auth,(req,res)=>res.json(db.prepare('SELECT id,amount_kobo,bank_name,account_name,account_number,status,created_at,processed_at FROM withdrawals WHERE user_id=? ORDER BY id DESC').all(req.session.userId).map(x=>({...x,amount:naira(x.amount_kobo)}))));

app.post('/api/admin/login',async(req,res)=>{const {username,password}=req.body||{}; if(username!==ADMIN_USER||!ADMIN_PASSWORD||password!==ADMIN_PASSWORD)return res.status(401).json({error:'Invalid admin login'}); req.session.admin=true;res.json({ok:true});});
app.get('/api/admin/stats',admin,(req,res)=>res.json({users:db.prepare('SELECT COUNT(*) c FROM users').get().c,cards:db.prepare('SELECT COUNT(*) c FROM cards').get().c,pending:db.prepare("SELECT COUNT(*) c FROM withdrawals WHERE status='pending'").get().c,pending_amount:naira(db.prepare("SELECT COALESCE(SUM(amount_kobo),0) s FROM withdrawals WHERE status='pending'").get().s)}));
app.get('/api/admin/withdrawals',admin,(req,res)=>res.json(db.prepare(`SELECT w.*,u.name,u.phone FROM withdrawals w JOIN users u ON u.id=w.user_id ORDER BY w.id DESC`).all().map(x=>({...x,amount:naira(x.amount_kobo)}))));
app.post('/api/admin/withdrawals/:id/pay',admin,(req,res)=>{const w=db.prepare('SELECT * FROM withdrawals WHERE id=?').get(req.params.id);if(!w||w.status!=='pending')return res.status(400).json({error:'Invalid withdrawal'});db.prepare("UPDATE withdrawals SET status='paid',processed_at=CURRENT_TIMESTAMP WHERE id=?").run(w.id);res.json({ok:true});});
app.post('/api/admin/withdrawals/:id/reject',admin,(req,res)=>{const tx=db.transaction(()=>{const w=db.prepare('SELECT * FROM withdrawals WHERE id=?').get(req.params.id);if(!w||w.status!=='pending')throw new Error('Invalid withdrawal');db.prepare("UPDATE withdrawals SET status='rejected',processed_at=CURRENT_TIMESTAMP WHERE id=?").run(w.id);db.prepare('UPDATE users SET balance_kobo=balance_kobo+? WHERE id=?').run(w.amount_kobo,w.user_id);});try{tx();res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/admin/prizes',admin,(req,res)=>res.json(db.prepare('SELECT id,name,amount_kobo,weight,active FROM prizes ORDER BY id').all().map(x=>({...x,amount:naira(x.amount_kobo)}))));
app.post('/api/admin/prizes/:id',admin,(req,res)=>{const {name,amount_kobo,weight,active}=req.body||{};db.prepare('UPDATE prizes SET name=?,amount_kobo=?,weight=?,active=? WHERE id=?').run(name,Number(amount_kobo),Number(weight),active?1:0,req.params.id);res.json({ok:true});});

app.use(express.static(path.join(__dirname,'public')));
app.get('/admin',(req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
app.listen(PORT,()=>console.log(`Savage Presidential server running on ${PORT}`));
