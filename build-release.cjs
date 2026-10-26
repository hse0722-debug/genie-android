const fs=require('fs'),path=require('path'),crypto=require('crypto');
const version=process.argv[2];
if(!/^\d+\.\d+\.\d+$/.test(version||''))throw Error('Usage: node build-release.cjs 9.0.1');
const manifest={schema:1,loaderApi:1,version};
for(const role of ['content','engine']){
 const bytes=fs.readFileSync(path.join(__dirname,role+'.js'));
 const file=`genie-${role}-${version}.js`,target=path.join(__dirname,file);
 if(fs.existsSync(target)&&!fs.readFileSync(target).equals(bytes))throw Error('Version already exists; choose a new version: '+version);
 fs.writeFileSync(target,bytes);
 manifest[role]={file,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
}
fs.writeFileSync(path.join(__dirname,'release.json'),JSON.stringify(manifest,null,2)+'\n');
console.log('Release prepared: '+version);
