export class PasteHandler {
  private pastes: string[] = [];
  add(text:string): string { const clean=text.replace(/\r\n?/g,'\n'); if(!clean.includes('\n')) return clean; this.pastes.push(clean); return `[paste#${this.pastes.length}: ${clean.split('\n').filter(Boolean).length} lines]`; }
  expand(line:string): string { return line.replace(/\[paste#(\d+): \d+ lines\]/g, (m,n)=>this.pastes[Number(n)-1]??m); }
  count():number{return this.pastes.length;}
  clear():void{this.pastes=[];}
}
