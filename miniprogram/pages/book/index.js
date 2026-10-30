const catalog = require('../../utils/course');
const storage = require('../../utils/storage');
const player = require('../../utils/player');
const notices = require('../../utils/notices');
function clock(seconds) { const s=Math.floor(seconds||0); return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0'); }
Page({
  data: { listId: 1, listOptions: [], listIndex: 0, vocabulary: [], examples: [],
    speedOptions: ['0.5×','0.75×','1.0×','1.25×'], speedValues:[0.5,0.75,1,1.25], speedIndex:2,
    detail:null, playingId:'', playingMode:'', playing:false, paused:false, loading:false,
    focus:false, focusWords:[], focusText:'', focusCount:'', focusLong:false,
    currentTime:'00:00', duration:'00:00', playerText:'', unread:0, popup:null,loadingUnit:false,loadError:'',requestedUnit:1 },
  onLoad() {
    this.setData({listOptions:Array.from({length:catalog.course.totalLists},(_,i)=>({id:i+1,title:'Unit '+(i+1)+(catalog.course.lists[i+1]?'':' · 待添加')}))});
    const saved=Number(storage.get('speed',1));
    const speedIndex=this.data.speedValues.indexOf(saved);
    this.setData({speedIndex:speedIndex<0?2:speedIndex});
    player.setSpeed(this.data.speedValues[this.data.speedIndex]);
    this.ready=this.renderList(Number(storage.get('currentList',1)));
  },
  onShow() {
    if (!this.unsubscribe) this.unsubscribe=player.subscribe(s=>this.onPlayer(s));
    notices.getAll().then(all=>{
      this.setData({unread:all.filter(n=>!n.read).length});
      const next=all.find(n=>!n.read&&n.popup!==false);
      if(next&&!this.data.playing) this.setData({popup:next});
    }).catch(()=>{});
  },
  onHide(){player.stop();if(this.unsubscribe)this.unsubscribe();this.unsubscribe=null;},
  onUnload(){this.unitRequest=(this.unitRequest||0)+1;this.onHide();},
  async renderList(number){
    const request=(this.unitRequest||0)+1;this.unitRequest=request;
    player.stop();this.focusId='';this.setData({loadingUnit:true,loadError:'',requestedUnit:number,detail:null});
    try{
      const bundle=await catalog.loadUnit(number);if(request!==this.unitRequest)return;
      const list=bundle.unit;
      const target=new Set(list.vocabulary.map(w=>catalog.normalize(w.word)).concat(...list.examples.map(e=>e.targetForms||[])).map(catalog.normalize));
      this.setData({listId:number,listIndex:number-1,vocabulary:list.vocabulary,
        examples:list.examples.map((e,i)=>({...e,number:String(i+1).padStart(2,'0'),tokens:catalog.tokens(e.text,e.annotations).map(t=>({...t,target:t.word&&target.has(catalog.normalize(t.text))}))}))});
      storage.set('currentList',number);
    }catch(err){if(request===this.unitRequest){
      console.error('[course] Unit '+number+' 加载失败',err);
      this.setData({loadError:err.message||'单元加载失败，请重新进入后重试。'});
    }}
    finally{if(request===this.unitRequest)this.setData({loadingUnit:false});}
  },
  retryUnit(){this.renderList(this.data.requestedUnit);},
  changeList(e){this.renderList(Number(e.detail.value)+1);},
  changeSpeed(e){const i=Number(e.detail.value);this.setData({speedIndex:i});storage.set('speed',this.data.speedValues[i]);player.setSpeed(this.data.speedValues[i]);},
  playWord(e){if(this.data.loadingUnit)return;const word=this.data.vocabulary[Number(e.currentTarget.dataset.index)];if(!word)return;this.setData({detail:null,popup:null});player.start([{id:word.id,text:word.word,src:word.audio,type:'word'}],'word');},
  playVocabulary(){if(this.data.loadingUnit)return;this.setData({detail:null,popup:null});player.start(this.data.vocabulary.map(w=>({id:w.id,text:w.word,src:w.audio,type:'word'})),'vocabulary');},
  playExample(e){const item=this.data.examples[Number(e.currentTarget.dataset.index)];this.startExamples([item]);},
  playExamples(){this.startExamples(this.data.examples);},
  startExamples(items){if(this.data.loadingUnit)return;this.setData({detail:null,popup:null});player.start(items.map(e=>({id:e.id,text:e.speechText||e.text,src:e.audio,type:'sentence'})),'examples');},
  showWord(e){if(this.data.loadingUnit)return;player.stop();this.setData({detail:catalog.getWord(e.currentTarget.dataset.word,this.data.listId)});},
  copySource(){if(this.data.detail&&this.data.detail.sourceUrl)wx.setClipboardData({data:this.data.detail.sourceUrl});},
  closeDetail(){player.stop();this.setData({detail:null});},
  playDetail(){const d=this.data.detail;if(d&&d.audio)player.start([{id:'word-detail',text:d.word,src:d.audio,type:'word'}],'detail');},
  onPlayer(s){
    if(!s.active){if(this.data.focus&&wx.showTabBar)wx.showTabBar({animation:false});this.focusId='';this.setData({playing:false,focus:false,playingId:'',playingMode:''});return;}
    const item=s.item;
    const patch={playing:true,playingId:item.id,playingMode:s.mode,paused:s.paused,loading:s.loading,
      currentTime:clock(s.current),duration:clock(s.duration),playerText:item.text,
      focus:item.type==='sentence',focusCount:s.total>1?(s.index+1)+' / '+s.total:'整句朗读'};
    if(item.type==='sentence'){
      if(!this.data.focus&&wx.hideTabBar)wx.hideTabBar({animation:false});
      if(this.focusId!==item.id){
        this.focusId=item.id;
        this.focusPieces=catalog.focusPieces(item.text);
        this.focusTimings=(catalog.getTimings(item.src,this.data.listId)||{}).words||[];
        patch.focusWords=this.focusPieces.map((piece,i)=>({id:i,text:piece.text,spaceAfter:piece.spaceAfter,pct:0}));
        patch.focusLong=item.text.length>180;patch.focusText=item.text;
      }
      const aligned=this.focusTimings.length===this.focusPieces.length&&this.focusTimings.every((t,i)=>catalog.normalize(t.text)===this.focusPieces[i].key);
      this.focusPieces.forEach((piece,i)=>{
        let from,to;
        if(aligned){from=this.focusTimings[i].start;to=this.focusTimings[i].end;}
        else{from=i/this.focusPieces.length*s.duration;to=(i+1)/this.focusPieces.length*s.duration;}
        const pct=s.duration?Math.max(0,Math.min(100,(s.current-from)/Math.max(.05,to-from)*100)):0;
        if(patch.focusWords)patch.focusWords[i].pct=pct;
        else patch['focusWords['+i+'].pct']=pct;
      });
    }
    this.setData(patch);
  },
  toggle(){player.toggle();},rewind(){player.seek(-5);},forward(){player.seek(5);},stop(){player.stop();},
  openNotices(){wx.navigateTo({url:'/pages/notices/index'});},
  dismissPopup(){this.setData({popup:null});},
  async readPopup(){const n=this.data.popup;if(!n)return;await notices.markRead(n.id);this.setData({popup:null,unread:Math.max(0,this.data.unread-1)});},
  noop(){}
});
