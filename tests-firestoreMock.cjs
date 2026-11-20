'use strict';
function inMemoryFirestore(){
 const state=new Map();let tail=Promise.resolve();
 const clone=v=>v===undefined?undefined:structuredClone(v);
 const snap=(key)=>{const value=state.get(key);return {exists:value!==undefined,id:key.split('/').at(-1),data:()=>clone(value)};};
 const collection=key=>({
  doc(id){return doc(key+'/'+id);},
  where(field,operator,value){return query(key,[{field,operator,value}]);},
  orderBy(field,direction='asc'){return query(key,[],[{field,direction}]);},
  limit(n){return query(key,[],[],n);},
  async get(){return query(key,[]).get();}
 });
 const doc=key=>({key,id:key.split('/').at(-1),collection(sub){return collection(key+'/'+sub);},get:async()=>snap(key),set:async(v,opt={})=>{state.set(key,opt.merge?{...state.get(key),...clone(v)}:clone(v));},create:async(v)=>{if(state.has(key))throw Error('ALREADY_EXISTS');state.set(key,clone(v));},delete:async()=>{state.delete(key);}});
 const query=(key,filters=[],orders=[],max=Infinity)=>({
  where(f,op,v){return query(key,[...filters,{field:f,operator:op,value:v}],orders,max);},
  orderBy(field,direction='asc'){return query(key,filters,[...orders,{field,direction}],max);},
  limit(n){return query(key,filters,orders,n);},
  async get(){const rows=[];const direct=key.split('/').length+1;
   for(const [id,value] of state){if(!id.startsWith(key+'/')||id.split('/').length!==direct)continue;
    if(!filters.every(({field,operator,value:expected})=>operator==='array-contains'?Array.isArray(value[field])&&value[field].includes(expected):operator==='=='?value[field]===expected:operator==='in'?Array.isArray(expected)&&expected.includes(value[field]):operator==='<'?value[field]<expected:false))continue;
    rows.push({id:id.split('/').at(-1),data:()=>clone(value),exists:true});
   }
   for(const {field,direction} of orders)rows.sort((a,b)=>{const x=a.data()[field],y=b.data()[field];return (x>y?1:x<y?-1:0)*(direction==='desc'?-1:1);});
   const docs=rows.slice(0,max);return {docs,empty:docs.length===0,size:docs.length};
  }
 });
 const db={collection,
  async runTransaction(callback){
   let release;const prior=tail;tail=new Promise(r=>release=r);await prior;
   const writes=[];
   const tx={get:async(ref)=>snap(ref.key),create:(ref,value)=>writes.push({action:'create',ref,value}),set:(ref,value,opt)=>writes.push({action:'set',ref,value,opt}),update:(ref,value)=>writes.push({action:'update',ref,value}),delete:ref=>writes.push({action:'delete',ref})};
   try{const result=await callback(tx);
    for(const {action,ref} of writes)if(action==='create'&&state.has(ref.key))throw Error('ALREADY_EXISTS');
    for(const {action,ref,value,opt} of writes){const key=ref.key;if(action==='delete'){state.delete(key);continue;}
      const base=clone(value);state.set(key,action==='update'||(action==='set'&&opt?.merge)?{...(state.get(key)||{}),...base}:base);
    }
    return result;
   }finally{release();}
  }
 };
 return {db,state};
}
module.exports={inMemoryFirestore};
