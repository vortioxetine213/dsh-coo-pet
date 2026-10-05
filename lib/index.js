/**
 * DSH 桌宠插件的入口(**薄壳**)。
 *
 * 真正的实现在同目录的 `impl.js`,这里只做一件事:**动态 import** 它,
 * 而且每次挂载都换一个查询串。
 *
 * 为什么要这么绕——DSH(Cordis)的模块缓存是按入口模块钉死的,人家踩过三次:
 * 改 `impl.js` 的内容、改 `package.json` 的 `main` 换入口文件、`set_bundle` 关掉再打开,
 * **都换不掉已经加载过的那份代码**,只有重启 DSH 才会重新读。
 * 结果就是每改一行都得重启主人正在用的 DSH,或者把包名加个后缀重新装一遍。
 *
 * 动态 import 带上 `?v=<时间戳>` 之后,每次挂载都是一个**新的模块 URL**,
 * 于是「重载插件」就等于「拿到最新代码」——不用重启、也不用改包名。
 *
 * 代价:插件晚一个微任务挂载,所以入口同步返回、异步 setup。
 */
export const name = 'dsh-desktop-pet';
export const inject = ['tools', 'llm', 'agentDefaultModel'];

export function apply(ctx, config = {}) {
  const rev = Date.now().toString(36);
  void import(`./impl.js?v=${rev}`)
    .then((mod) => mod.setup(ctx, config))
    .catch((err) => {
      ctx.logger?.error?.('[桌宠] 实现模块加载失败', err);
    });
}
