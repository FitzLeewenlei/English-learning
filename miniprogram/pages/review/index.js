const study=require('../../utils/study');
const catalog=require('../../utils/course');
const player=require('../../utils/player');
const api=require('../../utils/api');
Page({
  data:{stats:{},session:false,finished:false,card:null,revealed:false,remaining:0,completed:0,
    dictation:false,answer:'',checked:false,correct:false,showExample:false,example:null,cloud:false,cardLoading:false,cardError:''},
  onShow(){this.active=true;this.refresh();if(this.data.session&&this.data.cardLoading)this.showCard();study.sync().then(()=>this.refresh()).catch(()=>{});},
  onHide(){this.active=false;this.cardRequest=(this.cardRequest||0)+1;player.stop();},onUnload(){this.onHide();},
  refresh(){this.setData({stats:study.summary(),cloud:api.enabled()});},
  start(e){
    const kind=e.currentTarget.dataset.kind;
    this.cards=kind==='dictation'?study.queue('review').concat(study.queue('new')):study.queue(kind);
    if(!this.cards.length){wx.showToast({title:kind==='review'?'目前没有到期复习的词':'今日计划已完成，可以浏览词书继续学习',icon:'none'});return;}
    this.cursor=0;this.setData({session:true,finished:false,completed:0,dictation:kind==='dictation'});return this.showCard();
  },
  async showCard(){
    player.stop();
    const request=(this.cardRequest||0)+1;this.cardRequest=request;
    if(this.cursor>=this.cards.length){this.setData({session:false,finished:true});this.refresh();return;}
    const card=this.cards[this.cursor];
    this.setData({card,revealed:false,answer:'',checked:false,correct:false,showExample:false,example:null,remaining:this.cards.length-this.cursor,cardLoading:true,cardError:''});
    try{const bundle=await catalog.loadUnit(card.listId);if(request!==this.cardRequest||!this.data.session||this.active===false)return;
      this.setData({example:bundle.unit.examples[card.exampleIndex]||null,cardLoading:false});
      if(this.data.dictation)this.play();
    }catch(err){if(request===this.cardRequest)this.setData({cardLoading:false,cardError:'例句资料暂未加载成功，可重试后继续。'});}
  },
  reveal(){this.setData({revealed:true});},
  play(){if(this.active===false)return;const c=this.data.card;if(c)player.start([{id:c.id,src:c.audio,text:c.word,type:'word'}],'review');},
  playExample(){const e=this.data.example;if(e)player.start([{id:e.id,src:e.audio,text:e.speechText||e.text,type:'sentence'}],'review-example');},
  retryCard(){return this.showCard();},
  toggleExample(){this.setData({showExample:!this.data.showExample});},
  answerInput(e){this.setData({answer:e.detail.value});},
  check(){
    if(!this.data.answer.trim()){wx.showToast({title:'先输入你听到的单词',icon:'none'});return;}
    const correct=catalog.normalize(this.data.answer.trim())===catalog.normalize(this.data.card.word);
    this.setData({checked:true,correct,revealed:true});
  },
  rate(e){
    if(this.data.cardLoading||this.data.cardError)return;
    let rating=e.currentTarget.dataset.rating;
    if(this.data.dictation&&!this.data.checked)return;
    if(this.data.dictation&&!this.data.correct)rating='again';
    try{
      study.rate(this.data.card,rating,{mode:this.data.dictation?'dictation':'recall',answerCorrect:this.data.dictation?this.data.correct:undefined});
      if(rating==='again')this.cards.splice(Math.min(this.cards.length,this.cursor+3),0,this.data.card);
      this.cursor+=1;this.setData({completed:this.data.completed+1});return this.showCard();
    }catch(err){api.error(err);}
  },
  finish(){this.cardRequest=(this.cardRequest||0)+1;player.stop();this.setData({session:false,finished:false});this.refresh();},
  openBook(){wx.switchTab({url:'/pages/book/index'});}
});
