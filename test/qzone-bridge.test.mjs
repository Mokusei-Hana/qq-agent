import test from 'node:test';
import assert from 'node:assert/strict';
import { QzoneBridgeClient, QzoneBridgeError, mapBridgeComments } from '../src/qzone-bridge.js';

function clientWith(handler, settings = {}) {
  const calls = [];
  const client = new QzoneBridgeClient({
    config: () => ({
      qzoneBridge: {
        enabled: true,
        baseUrl: 'http://bridge.local:5700/',
        accessToken: 'secret',
        timeoutMs: 15000,
        ...settings
      }
    }),
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body || '{}');
      calls.push({ url, body, headers: options.headers });
      return {
        ok: true,
        status: 200,
        json: async () => handler(url, body)
      };
    }
  });
  return { client, calls };
}

test('maps own moments and drops Qzone ads from get_emotion_list', async () => {
  const { client, calls } = clientWith(() => ({
    status: 'ok',
    retcode: 0,
    data: {
      msglist: [
        {
          tid: 'abc',
          uin: '10001',
          nickname: '我',
          content: '今天吃鱼',
          created_time: 1700000000,
          cmtnum: 3,
          appid: '311',
          pics: [{ url1: 'https://p1.qpic.cn/a.jpg' }]
        },
        { tid: '333_x', uin: '88882222', content: '恭喜开通黄钻', appid: '333' }
      ]
    }
  }));
  const result = await client.getMoments({ num: 5 });
  assert.equal(calls[0].url, 'http://bridge.local:5700/get_emotion_list');
  assert.equal(calls[0].headers.authorization, 'Bearer secret');
  assert.equal(calls[0].body.include_image_data, false);
  assert.deepEqual(result.msglist, [{
    tid: 'abc',
    uin: '10001',
    nickname: '我',
    content: '今天吃鱼',
    time: 1700000000,
    comment_num: 3,
    images: ['https://p1.qpic.cn/a.jpg'],
    isLiked: false
  }]);
});

test('maps friend feeds into internal post shape', async () => {
  const { client } = clientWith((url) => {
    assert.equal(url, 'http://bridge.local:5700/get_friend_feeds');
    return {
      status: 'ok',
      retcode: 0,
      data: {
        msglist: [{
          tid: 'feeds-tid',
          uin: '20002',
          nickname: '好友',
          content: '下雨了',
          createdTime: 1700000100,
          appid: '311',
          pics: ['https://p2.qpic.cn/b.jpg'],
          likenum: 2
        }]
      }
    };
  });
  const posts = await client.getFeedPosts({ count: 30 });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].tid, 'feeds-tid');
  assert.equal(posts[0].appid, 311);
  assert.equal(posts[0].time, 1700000100);
  assert.deepEqual(posts[0].images, ['https://p2.qpic.cn/b.jpg']);
  assert.equal(posts[0].likeCount, 2);
  assert.deepEqual(posts[0].comments, []);
});

test('publishes a moment as text plus image segments and keeps visibility', async () => {
  const { client, calls } = clientWith(() => ({
    status: 'ok',
    retcode: 0,
    data: { tid: 'new-tid', pic_ids: ['pic-1'] }
  }));
  const result = await client.publishMoment('晚安', {
    images: ['base64://AAAA'],
    ugcRight: 4
  });
  assert.deepEqual(calls[0].body.message, [
    { type: 'text', data: { text: '晚安' } },
    { type: 'image', data: { file: 'base64://AAAA' } }
  ]);
  assert.equal(calls[0].body.who_can_see, 4);
  assert.equal(result.tid, 'new-tid');
});

test('flattens nested comment replies with parent tids', async () => {
  const comments = mapBridgeComments([{
    commentId: 'c1',
    uin: '30003',
    nickname: '甲',
    content: '楼主好',
    createdTime: 1700000200,
    replies: [{
      commentId: 'c2',
      uin: '10001',
      nickname: '我',
      content: '谢谢',
      createdTime: 1700000300,
      replyToUin: '30003',
      replyToNickname: '甲'
    }]
  }]);
  assert.equal(comments.length, 2);
  assert.equal(comments[0].parentTid, '');
  assert.equal(comments[1].parentTid, 'c1');
  assert.equal(comments[1].targetUin, '30003');
  assert.equal(comments[1].targetName, '甲');
});

test('returns comment list and count through get_comment_list', async () => {
  const { client, calls } = clientWith(() => ({
    status: 'ok',
    retcode: 0,
    data: {
      comments: [{ commentId: 'c9', uin: '30003', nickname: '甲', content: '在吗', createdTime: 1700000400 }],
      comment_num: 1
    }
  }));
  const detail = await client.getComments({ uin: '10001', tid: 'abc', num: 20 });
  assert.equal(calls[0].body.user_id, '10001');
  assert.equal(detail.commentCount, 1);
  assert.equal(detail.comments[0].commentId, 'c9');
  assert.equal(detail.comments[0].time, 1700000400);
});

test('replies with native reply parameters', async () => {
  const { client, calls } = clientWith(() => ({
    status: 'ok',
    retcode: 0,
    data: { comment_id: 'c10' }
  }));
  const result = await client.replyComment({
    uin: '20002',
    tid: 'feeds-tid',
    content: '是啊',
    rootComment: { tid: 'c1', commentId: 'c1', uin: '30003' }
  });
  assert.equal(calls[0].body.target_tid, 'feeds-tid');
  assert.equal(calls[0].body.reply_comment_id, 'c1');
  assert.equal(calls[0].body.reply_uin, '30003');
  assert.equal(result.commentId, 'c10');
});

test('raises a typed error on bridge failures', async () => {
  const { client } = clientWith(() => ({
    status: 'failed',
    retcode: 1401,
    message: '未登录'
  }));
  await assert.rejects(
    () => client.getMoments(),
    (error) => error instanceof QzoneBridgeError
      && error.retcode === 1401
      && /未登录/.test(error.message)
  );
});

test('stays disabled until explicitly enabled', () => {
  const client = new QzoneBridgeClient({
    config: () => ({ qzoneBridge: { enabled: false } })
  });
  assert.equal(client.enabled, false);
  assert.equal(client.settings.baseUrl, 'http://127.0.0.1:5700');
});
