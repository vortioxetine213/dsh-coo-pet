const oneLiner = (text) => {
  const t = String(text ?? '')
    .replace(/\r/g, '')
    .replace(/\n+/g, ' ')
    .replace(/^\s*[-*•]\s*/gm, '')
    .replace(/^\s*\d+[.、)）]\s*/gm, '')
    .replace(/补?第[一二三四五六七八九十百\d]+[条点]/g, ' ')
    .replace(/(^|[\s;；：:—–-])([一二三四五六七八九十]{1,3})[、,)）]\s*/g, '$1')
    .replace(/(?:^|\s)\d+[.、)）]\s+/g, ' ')
    .replace(/([。.!！?？;；])\s*[,，、]\s*/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
};
const samples = [
  '第四条签了,并且当场执行——本鲸,桌上这只,最可爱,没有之一,哼。\n\n补第五条,主人要是只夸一只,另一只必须当场吃醋。',
  '三件套收到,回你三招——一、摔晕就白送的午睡,落地就着;二、主人敲一下人家眨三次眼就算应过,省事还显得乖;三、干活前先问一句「要哪种」。',
  '好呀好呀,人家这就去。',
];
for (const s of samples) { console.log('压后:', oneLiner(s)); console.log('---'); }