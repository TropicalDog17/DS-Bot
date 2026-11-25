import dingtalk from './dingtalk.ts'
import discord from './discord.ts'
import feishu from './feishu.ts'
import qq from './qq.ts'
import slack from './slack.ts'
import telegram from './telegram.ts'
import wecom from './wecom.ts'
import weixin from './weixin.ts'

export const adapters = { telegram, discord, slack, qq, dingtalk, wecom, feishu, weixin }
