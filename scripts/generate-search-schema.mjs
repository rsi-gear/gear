import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
const base=fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const cfg=ts.readConfigFile(`${base}/tsconfig.json`,ts.sys.readFile).config;
const parsed=ts.parseJsonConfigFileContent(cfg,ts.sys,base);
const program=ts.createProgram(parsed.fileNames,parsed.options), checker=program.getTypeChecker();
const named=new Map(), defs={};
for(const file of ['types.ts','engine.ts','runtime.ts','regression.ts','completion.ts','epochs.ts','shadow.ts','store.ts','../objective/types.ts']) {
 const source=program.getSourceFile(`${base}/src/search/${file}`);
 for(const symbol of checker.getExportsOfModule(checker.getSymbolAtLocation(source))) {
  const decl=symbol.declarations?.[0];
  if(!decl || !(ts.isInterfaceDeclaration(decl)||ts.isTypeAliasDeclaration(decl))) continue;
  if(['SearchProvider','DiagnosisProvider','SearchExecutionHooks'].includes(symbol.name)) continue;
  named.set(checker.getDeclaredTypeOfSymbol(symbol),symbol.name);
 }
}
function schema(type, defining) {
 const name=named.get(type); if(name&&name!==defining) return {$ref:`#/$defs/${name}`};
 if(type.flags & ts.TypeFlags.StringLiteral) return {const:type.value};
 if(type.flags & ts.TypeFlags.NumberLiteral) return {const:type.value};
 if(type.flags & ts.TypeFlags.BooleanLiteral) return {const:type.intrinsicName==='true'};
 if(type.flags & ts.TypeFlags.String) return {type:'string'};
 if(type.flags & ts.TypeFlags.Number) return {type:'number'};
 if(type.flags & ts.TypeFlags.Boolean) return {type:'boolean'};
 if(type.flags & ts.TypeFlags.Null) return {type:'null'};
 if(type.isUnion()) { const items=type.types.filter(t=>!(t.flags & ts.TypeFlags.Undefined)).map(t=>schema(t)); return items.length===1?items[0]:{anyOf:items}; }
 if(checker.isArrayType(type)) return {type:'array',items:schema(checker.getTypeArguments(type)[0])};
 if(type.flags & ts.TypeFlags.Object || type.isIntersection()) {
  const properties={},required=[];
  for(const prop of checker.getPropertiesOfType(type)) {
   const decl=prop.valueDeclaration??prop.declarations?.[0];
   const t=checker.getTypeOfPropertyOfType(type, prop.name) ?? (decl ? checker.getTypeOfSymbolAtLocation(prop,decl) : undefined); if(!t)continue; if(t.getCallSignatures().length)continue;
   properties[prop.name]=schema(t);
   if(!(prop.flags&ts.SymbolFlags.Optional))required.push(prop.name);
  }
  const index=checker.getIndexTypeOfType(type,ts.IndexKind.String);
  return {type:'object',...(Object.keys(properties).length?{properties}:{}),...(required.length?{required}:{}),additionalProperties:index?schema(index):false};
 }
 return {};
}
for(const [type,name] of named)defs[name]=schema(type,name);
const result={$schema:'https://json-schema.org/draft/2020-12/schema',$id:'https://gear.local/schemas/search-v2',title:'Failure cluster GEPA v1 persisted contracts', $defs:defs};
fs.writeFileSync(`${base}/src/search/schema.json`,JSON.stringify(result,null,2)+'\n');
