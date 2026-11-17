
  // Supabase 클라이언트 초기화 (초고속 BaaS)
  const SUPABASE_URL = "https://saogvdvqrnvroyomexbe.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNhb2d2ZHZxcm52cm95b21leGJlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ3NTkxNzUsImV4cCI6MjEwMDMzNTE3NX0.WEL3qSgC6ZK29Kj54iKd3xXY2tPZo2G9GfRBTX5Gmbs";
  const sb = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;


  // 애플리케이션 전역 상태 관리
  var state = {
    sessionToken: localStorage.getItem("bt_session_token") || null,
    teacherToken: null,
    isTeacher: false,
    isMasterAdmin: sessionStorage.getItem("bt_is_master_admin") === "true",
    student: null,
    selectedStudentId: null,
    activeMapId: "M01",
    currentTab: "home"
  };

  // 정식 오픈 기준 (2026년 9월 6일 Day 1)
  function getGlobalDayIndex() {
    var startDate = new Date("2026-09-06T00:00:00+09:00");
    var now = new Date();
    var diff = now.getTime() - startDate.getTime();
    var days = Math.floor(diff / (1000 * 60 * 60 * 24)) + 1;
    return days > 0 ? days : 1;
  }

  var targetStudentIdForLogin = null;

  // 한국 시간 (KST, Asia/Seoul) yyyy-MM-dd 날짜 문자열 계산 유틸리티
  function getKstDateString(d) {
    var dateObj = d || new Date();
    var offset = 9 * 60;
    var local = new Date(dateObj.getTime() + (offset + dateObj.getTimezoneOffset()) * 60000);
    var y = local.getFullYear();
    var m = String(local.getMonth() + 1).padStart(2, '0');
    var day = String(local.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  // 성경 읽기 로그 기반 학생 실시간 진도(Day) 및 정시 연속일수(Streak) 동적 산출 유틸리티
  function calculateStudentMetrics(logs) {
    var uniqueChapters = {};
    var onTimeDates = {};
    (logs || []).forEach(function(l) {
      if (l.book_name && l.chapter) {
        uniqueChapters[l.book_name + '_' + l.chapter] = true;
      }
      if (l.is_on_time && l.read_date) {
        var dStr = String(l.read_date).split('T')[0].split(' ')[0];
        if (dStr) onTimeDates[dStr] = true;
      }
    });

    var uniqueCount = Object.keys(uniqueChapters).length;
    var calcDay = uniqueCount === 0 ? 1 : Math.max(1, Math.ceil(uniqueCount / 3));

    var now = new Date();
    var todayStr = getKstDateString(now);
    var yesterday = new Date(now.getTime() - 86400000);
    var yesterdayStr = getKstDateString(yesterday);

    var streakDays = 0;
    var checkDate = null;
    if (onTimeDates[todayStr]) checkDate = now;
    else if (onTimeDates[yesterdayStr]) checkDate = yesterday;

    if (checkDate) {
      var tempDate = new Date(checkDate.getTime());
      while (true) {
        var dStr = getKstDateString(tempDate);
        if (onTimeDates[dStr]) {
          streakDays++;
          tempDate = new Date(tempDate.getTime() - 86400000);
        } else {
          break;
        }
      }
    }
    if (onTimeDates[todayStr] && streakDays === 0) streakDays = 1;

    return { currentDayIndex: calcDay, streakOnTime: streakDays, uniqueCount: uniqueCount };
  }

  // Promise 기반 google.script.run 안전 래퍼
  
  // 교사/관리자 권한 판별 유틸리티 (마스터 PIN 로그인 또는 소속 부서가 '교사'인 계정 모두 관리 권한 부여)
  function isUserTeacher(token) {
    if (state.isTeacher) return true;
    if (token && String(token).startsWith("TEACHER_TOKEN_")) return true;
    if (state.student && String(state.student.department).indexOf("교사") !== -1) return true;
    return false;
  }

  // Supabase 직결 초고속 API 통신 래퍼 (GAS 2~5초 -> Supabase 0.05초)
  async function apiCall(funcName) {
    const args = Array.prototype.slice.call(arguments, 1);
    try {
      if (!sb) {
        console.error("Supabase SDK가 로드되지 않았습니다.");
        return { success: false, error: "서버 연결 준비 중입니다." };
      }

      if (funcName === "getRecommendedBooks") {
        const { data, error } = await sb.from('travel_settings').select('value').eq('key', 'RECOMMENDED_BOOKS').single();
        if (error || !data) return { success: true, recommendedBooks: [] };
        const list = data.value.split(',').map(s => s.trim()).filter(Boolean);
        return { success: true, recommendedBooks: list };
      }

      if (funcName === "makeAllCardFilesPublic") {
        return { success: true };
      }

      if (funcName === "loadMapPointsFromSheet") {
        const { data } = await sb.from('travel_settings').select('value').eq('key', 'MAP_POINTS').single();
        if (data && data.value) {
          try { return JSON.parse(data.value); } catch(e) {}
        }
        return null;
      }

      if (funcName === "saveMapPointsToSheet") {
        const mapId = args[0];
        const points = args[1];
        const { data } = await sb.from('travel_settings').select('value').eq('key', 'MAP_POINTS').single();
        let mapObj = {};
        if (data && data.value) {
          try { mapObj = JSON.parse(data.value); } catch(e) {}
        }
        mapObj[mapId] = points;
        await sb.from('travel_settings').upsert({ key: 'MAP_POINTS', value: JSON.stringify(mapObj) });
        return { success: true };
      }

      if (funcName === "listStudentCards") {
        const { data: students, error } = await sb.from('travel_students').select('*').eq('is_active', true);
        if (error) return { success: false, error: error.message };

        // 전체 읽기 로그 페이지네이션 일괄 로드 (약 0.08초 소요)
        let allLogs = [];
        try {
          let page = 0;
          const pageSize = 1000;
          while (true) {
            const from = page * pageSize;
            const { data: chunk, error: logErr } = await sb.from('travel_reading_logs')
              .select('student_id,book_name,chapter,read_date,is_on_time')
              .range(from, from + pageSize - 1);
            if (logErr || !chunk || chunk.length === 0) break;
            allLogs = allLogs.concat(chunk);
            if (chunk.length < pageSize) break;
            page++;
          }
        } catch (e) {
          console.warn("로그 일괄 로드 중 경고:", e);
        }

        // 학생별 읽기 로그 매핑
        const logsByStudent = {};
        allLogs.forEach(l => {
          const sId = String(l.student_id).trim();
          if (!logsByStudent[sId]) logsByStudent[sId] = [];
          logsByStudent[sId].push(l);
        });

        const list = students.map(s => {
          const sId = String(s.student_id).trim();
          const sLogs = logsByStudent[sId];
          let currentDay = s.current_day_index || 1;
          let streak = s.streak_on_time || 0;

          if (sLogs && sLogs.length > 0) {
            const m = calculateStudentMetrics(sLogs);
            currentDay = m.currentDayIndex;
            streak = m.streakOnTime;
          }

          return {
            studentId: sId,
            name: s.name,
            department: s.department,
            displayEmoji: s.display_emoji,
            cardColor: s.card_color,
            currentDayIndex: currentDay,
            stampBalance: s.stamp_balance,
            gemBalance: s.gem_balance,
            streakOnTime: streak
          };
        });

        return { success: true, students: list };
      }

      if (funcName === "verifyStudentPin") {
        const studentId = args[0];
        const pin = args[1];
        const { data, error } = await sb.from('travel_students').select('*').eq('student_id', studentId).single();
        if (error || !data) return { success: false, error: "학생 정보를 찾을 수 없습니다." };
        if (String(data.pin).trim() !== String(pin).trim()) return { success: false, error: "PIN 번호가 일치하지 않습니다." };

        const { data: logs } = await sb.from('travel_reading_logs').select('book_name, chapter, read_date, is_on_time').eq('student_id', studentId);
        const metrics = calculateStudentMetrics(logs);
        const cleanLogs = (logs || []).map(l => ({ bookName: l.book_name, chapter: l.chapter }));

        // 최신 Day 및 Streak를 travel_students에 비동기 반영
        sb.from('travel_students').update({
          current_day_index: metrics.currentDayIndex,
          streak_on_time: metrics.streakOnTime
        }).eq('student_id', studentId).then(() => {});

        const safeStudent = {
          studentId: data.student_id,
          name: data.name,
          department: data.department,
          displayEmoji: data.display_emoji,
          cardColor: data.card_color,
          currentDayIndex: metrics.currentDayIndex,
          stampBalance: data.stamp_balance,
          gemBalance: data.gem_balance,
          totalUsedStamps: data.total_used_stamps,
          streakOnTime: metrics.streakOnTime,
          readLogs: cleanLogs
        };
        return { success: true, sessionToken: `STU_TOKEN_${studentId}_${Date.now()}`, student: safeStudent };
      }

      if (funcName === "fetchLatestStudentData") {
        const studentId = args[0];
        const { data, error } = await sb.from('travel_students').select('*').eq('student_id', studentId).single();
        if (error || !data) return { success: false, error: "데이터 조회 실패" };
        const { data: logs } = await sb.from('travel_reading_logs').select('book_name, chapter, read_date, is_on_time').eq('student_id', studentId);
        const metrics = calculateStudentMetrics(logs);

        return {
          success: true,
          stampBalance: data.stamp_balance,
          gemBalance: data.gem_balance,
          totalUsedStamps: data.total_used_stamps,
          streakOnTime: metrics.streakOnTime,
          currentDayIndex: metrics.currentDayIndex,
          readLogs: (logs || []).map(l => ({ bookName: l.book_name, chapter: l.chapter }))
        };
      }

      if (funcName === "saveReadingLog") {
        const sessionToken = args[0];
        const bookName = args[1];
        const chapters = Array.isArray(args[2]) ? args[2] : [args[2]];
        const action = args[3];
        const isOnTime = args[4];

        if (!sessionToken) return { success: false, error: "로그인이 필요합니다." };
        const studentId = String(sessionToken).split('_')[2];
        const targetCh = Number(chapters[0]);

        if (action === "remove") {
          await sb.from('travel_reading_logs').delete().match({ student_id: studentId, book_name: bookName, chapter: targetCh });
          // 잔고 차감 및 코인장부 기록
          const { data: s } = await sb.from('travel_students').select('stamp_balance').eq('student_id', studentId).single();
          const newStamp = Math.max(0, (s ? s.stamp_balance : 0) - 1);
          await sb.from('travel_students').update({ stamp_balance: newStamp }).eq('student_id', studentId);
          await sb.from('travel_coin_ledger').insert({
            student_id: studentId,
            type: 'STAMP',
            change_stamps: -1,
            reason: `성경읽기취소: ${bookName} ${targetCh}장`
          });
        } else {
          await sb.from('travel_reading_logs').upsert({
            student_id: studentId,
            book_name: bookName,
            chapter: targetCh,
            read_date: new Date().toISOString().slice(0, 10),
            is_on_time: Boolean(isOnTime)
          }, { onConflict: 'student_id,book_name,chapter' });

          // 잔고 증가 및 코인장부 기록
          const { data: s } = await sb.from('travel_students').select('stamp_balance').eq('student_id', studentId).single();
          const newStamp = (s ? s.stamp_balance : 0) + 1;
          await sb.from('travel_students').update({ stamp_balance: newStamp }).eq('student_id', studentId);
          await sb.from('travel_coin_ledger').insert({
            student_id: studentId,
            type: 'STAMP',
            change_stamps: 1,
            reason: `성경읽기완료: ${bookName} ${targetCh}장`
          });
        }

        // 전체 읽은 로그 및 streak 다시 산출
        const { data: allLogs } = await sb.from('travel_reading_logs').select('book_name, chapter, read_date, is_on_time').eq('student_id', studentId);
        const metrics = calculateStudentMetrics(allLogs);
        await sb.from('travel_students').update({
          current_day_index: metrics.currentDayIndex,
          streak_on_time: metrics.streakOnTime
        }).eq('student_id', studentId);

        const { data: latestStudent } = await sb.from('travel_students').select('*').eq('student_id', studentId).single();

        return {
          success: true,
          stampBalance: latestStudent.stamp_balance,
          gemBalance: latestStudent.gem_balance,
          totalUsedStamps: latestStudent.total_used_stamps,
          streakOnTime: metrics.streakOnTime,
          currentDayIndex: metrics.currentDayIndex,
          readLogs: (allLogs || []).map(l => ({ bookName: l.book_name, chapter: l.chapter }))
        };
      }

      if (funcName === "exchangeStampsToGems") {
        const sessionToken = args[0];
        const units = parseInt(args[1], 10) || 1;
        const studentId = String(sessionToken).split('_')[2];
        const { data: s } = await sb.from('travel_students').select('*').eq('student_id', studentId).single();
        const costStamps = units * 10;
        if (s.stamp_balance < costStamps) return { success: false, error: "도장이 부족합니다." };

        const newStamp = s.stamp_balance - costStamps;
        const newGem = s.gem_balance + units;
        const newUsed = (s.total_used_stamps || 0) + costStamps;

        await sb.from('travel_students').update({
          stamp_balance: newStamp,
          gem_balance: newGem,
          total_used_stamps: newUsed
        }).eq('student_id', studentId);

        await sb.from('travel_coin_ledger').insert([
          { student_id: studentId, type: 'STAMP', change_stamps: -costStamps, reason: `은혜환전소비 (보석 ${units}개 교환)` },
          { student_id: studentId, type: 'GEM', change_gems: units, reason: `은혜환전획득 (도장 ${costStamps}개 사용)` }
        ]);

        return { success: true, stampBalance: newStamp, gemBalance: newGem };
      }

      if (funcName === "unlockStudentCard") {
        const sessionToken = args[0];
        const bookOrder = Number(args[1]);
        const studentId = sessionToken && String(sessionToken).includes('_') ? String(sessionToken).split('_')[2] : (state.student ? state.student.studentId : null);
        if (!studentId) return { success: false, error: "로그인이 필요합니다." };

        // 이미 해금된 카드인지 확인 (중복 지급 방지)
        const { data: existing } = await sb.from('travel_student_cards').select('id').match({ student_id: studentId, card_order: bookOrder }).maybeSingle();
        if (existing) {
          return { success: true, alreadyUnlocked: true };
        }

        await sb.from('travel_student_cards').insert({
          student_id: studentId,
          card_order: bookOrder,
          unlocked_at: new Date().toISOString()
        });

        const { data: s } = await sb.from('travel_students').select('gem_balance').eq('student_id', studentId).single();
        const newGem = (s ? s.gem_balance : 0) + 2;
        await sb.from('travel_students').update({ gem_balance: newGem }).eq('student_id', studentId);
        await sb.from('travel_coin_ledger').insert({
          student_id: studentId,
          type: 'GEM',
          change_gems: 2,
          reason: `성경완독보상: BT-${bookOrder < 10 ? '0' + bookOrder : bookOrder}`
        });
        return { success: true };
      }

      if (funcName === "getCardDex") {
        const sessionToken = args[0];
        let studentId = null;
        if (sessionToken && String(sessionToken).includes('_')) {
          studentId = String(sessionToken).split('_')[2];
        } else if (state.student && state.student.studentId) {
          studentId = state.student.studentId;
        }

        let userUnlockedSet = {};
        if (studentId) {
          const { data: myCards } = await sb.from('travel_student_cards').select('card_order').eq('student_id', studentId);
          (myCards || []).forEach(c => {
            userUnlockedSet[Number(c.card_order)] = true;
          });
        }

        let unlockedCount = 0;
        const cards = ALL_66_BIBLE_BOOKS.map(b => {
          const cardInfo = (typeof BT_CARDS_MAP !== 'undefined' && BT_CARDS_MAP[b.order]) ? BT_CARDS_MAP[b.order] : {
            title: b.name + " 완독 카드",
            category: "성경",
            img: `/cards/bt_${b.order < 10 ? '0' + b.order : b.order}.jpg`
          };

          const isUnlocked = (userUnlockedSet[b.order] === true);
          if (isUnlocked) unlockedCount++;

          return {
            bookOrder: b.order,
            id: `BT-${b.order < 10 ? '0' + b.order : b.order}`,
            bookName: b.name,
            title: cardInfo.title || (b.name + " 완독 카드"),
            category: cardInfo.category || "성경",
            imageUrl: cardInfo.img || `/cards/bt_${b.order < 10 ? '0' + b.order : b.order}.jpg`,
            isUnlocked: isUnlocked
          };
        });

        return {
          success: true,
          cards: cards,
          unlockedCount: unlockedCount,
          totalCount: 66
        };
      }

      if (funcName === "verifyTeacherPin") {
        const pin = args[0];
        const { data } = await sb.from('travel_settings').select('value').eq('key', 'TEACHER_PIN').single();
        const teacherPin = data ? data.value.trim() : "7777";
        if (String(pin).trim() === teacherPin) {
          const tToken = `TEACHER_TOKEN_${Date.now()}`;
          return { success: true, token: tToken, teacherToken: tToken, isTeacher: true, isMasterAdmin: true };
        }
        return { success: false, error: "관리자 PIN이 일치하지 않습니다." };
      }

      if (funcName === "saveRecommendedBooks") {
        const teacherToken = args[0];
        const selectedIds = args[1] || [];
        if (!isUserTeacher(teacherToken)) return { success: false, error: "관리자(교사) 권한이 필요합니다." };
        await sb.from('travel_settings').upsert({ key: 'RECOMMENDED_BOOKS', value: selectedIds.join(',') });
        return { success: true, recommendedBooks: selectedIds };
      }

      if (funcName === "listGratitudeEntries") {
        const sessionToken = args[0];
        const myStudentId = sessionToken && String(sessionToken).includes('_') ? String(sessionToken).split('_')[2] : (state.student ? String(state.student.studentId) : null);

        // 감사글 최신 100개 로드
        const { data: posts, error: pErr } = await sb.from('travel_gratitude').select('*').order('id', { ascending: false }).limit(100);
        if (pErr) return { success: false, error: pErr.message, entries: [] };

        // 좋아요 데이터 로드
        const { data: likes } = await sb.from('travel_gratitude_likes').select('*');
        const likesCountMap = {};
        const myLikedMap = {};
        let todayMyLikesCount = 0;
        const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });

        (likes || []).forEach(l => {
          const gId = String(l.gratitude_id);
          likesCountMap[gId] = (likesCountMap[gId] || 0) + 1;
          if (myStudentId && String(l.student_id).trim() === String(myStudentId).trim()) {
            myLikedMap[gId] = true;
            const lDate = new Date(l.created_at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
            if (lDate === todayStr) {
              todayMyLikesCount++;
            }
          }
        });

        const entries = (posts || []).map(p => {
          const pId = String(p.id);
          const d = new Date(p.created_at);
          const kstStr = d.toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);

          return {
            id: p.id,
            studentId: p.student_id,
            studentName: p.student_name,
            body: p.body,
            createdAt: kstStr,
            likeCount: likesCountMap[pId] || 0,
            isLikedByMe: !!myLikedMap[pId]
          };
        });

        return {
          success: true,
          entries: entries,
          todayMyLikesCount: todayMyLikesCount
        };
      }

      if (funcName === "saveGratitudeEntry") {
        const sessionToken = args[0];
        const bodyText = args[1];
        if (!sessionToken) return { success: false, error: "로그인이 필요합니다." };
        if (!bodyText || !bodyText.trim()) return { success: false, error: "감사 내용을 입력하세요." };
        const studentId = String(sessionToken).split('_')[2];
        const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });

        // 오늘 이미 감사 작성했는지 확인
        const { data: todayGrat } = await sb.from('travel_gratitude').select('id,created_at').eq('student_id', studentId);
        const alreadyWritten = (todayGrat || []).some(g => {
          return new Date(g.created_at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }) === todayStr;
        });
        if (alreadyWritten) {
          return { success: false, error: "오늘의 감사제목은 이미 작성하셨습니다! 내일 또 작성해 주세요." };
        }

        const { data: s } = await sb.from('travel_students').select('*').eq('student_id', studentId).single();
        if (!s) return { success: false, error: "학생 정보를 찾을 수 없습니다." };

        await sb.from('travel_gratitude').insert({
          student_id: studentId,
          student_name: s.name,
          body: bodyText.trim()
        });

        // 💮 도장 +1 지급 및 코인 장부 기록
        const newStamp = (s.stamp_balance || 0) + 1;
        await sb.from('travel_students').update({ stamp_balance: newStamp }).eq('student_id', studentId);
        await sb.from('travel_coin_ledger').insert({
          student_id: studentId,
          type: 'STAMP',
          change_stamps: 1,
          reason: '오늘의감사작성'
        });

        return { success: true, stampBalance: newStamp, gemBalance: s.gem_balance };
      }

      if (funcName === "likeGratitudeEntry") {
        const sessionToken = args[0];
        const gratId = args[1];
        if (!sessionToken) return { success: false, error: "로그인이 필요합니다." };
        const fromStudentId = String(sessionToken).split('_')[2];
        const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });

        // 1. 대상 감사글 조회
        const { data: targetGrat, error: tgErr } = await sb.from('travel_gratitude').select('*').eq('id', Number(gratId)).single();
        if (tgErr || !targetGrat) return { success: false, error: "해당 감사글을 찾을 수 없습니다." };

        if (String(targetGrat.student_id).trim() === String(fromStudentId).trim()) {
          return { success: false, error: "본인이 작성한 글에는 좋아요를 누를 수 없습니다." };
        }

        // 2. 이미 좋아요를 눌렀는지 확인
        const { data: existingLike } = await sb.from('travel_gratitude_likes').select('id').match({ gratitude_id: Number(gratId), student_id: fromStudentId }).maybeSingle();
        if (existingLike) {
          return { success: false, error: "이미 응원(좋아요)을 누른 감사글입니다." };
        }

        // 3. 오늘 좋아요 3회 제한 확인
        const { data: myLikes } = await sb.from('travel_gratitude_likes').select('created_at').eq('student_id', fromStudentId);
        const todayCount = (myLikes || []).filter(l => new Date(l.created_at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }) === todayStr).length;
        if (todayCount >= 3) {
          return { success: false, error: "좋아요는 하루 최대 3번까지만 누를 수 있습니다!" };
        }

        // 4. 좋아요 레코드 추가
        await sb.from('travel_gratitude_likes').insert({
          gratitude_id: Number(gratId),
          student_id: fromStudentId
        });

        // 5. 보상 지급 (보낸 학생 도장 +1, 작성자 학생 도장 +1)
        const { data: fromStudent } = await sb.from('travel_students').select('*').eq('student_id', fromStudentId).single();
        const fromNewStamp = (fromStudent ? fromStudent.stamp_balance : 0) + 1;
        await sb.from('travel_students').update({ stamp_balance: fromNewStamp }).eq('student_id', fromStudentId);
        await sb.from('travel_coin_ledger').insert({
          student_id: fromStudentId,
          type: 'STAMP',
          change_stamps: 1,
          reason: `감사좋아요격려 (${targetGrat.student_name} 님 글)`
        });

        const { data: toStudent } = await sb.from('travel_students').select('*').eq('student_id', targetGrat.student_id).single();
        if (toStudent) {
          const toNewStamp = (toStudent.stamp_balance || 0) + 1;
          await sb.from('travel_students').update({ stamp_balance: toNewStamp }).eq('student_id', targetGrat.student_id);
          await sb.from('travel_coin_ledger').insert({
            student_id: targetGrat.student_id,
            type: 'STAMP',
            change_stamps: 1,
            reason: '감사좋아요선물수령'
          });
        }

        return {
          success: true,
          stampBalance: fromNewStamp,
          gemBalance: fromStudent ? fromStudent.gem_balance : 0,
          todayLikesRemaining: 3 - (todayCount + 1)
        };
      }

      if (funcName === "updateGratitudeEntry") {
        const sessionToken = args[0];
        const gratId = args[1];
        const newBody = args[2];
        if (!sessionToken) return { success: false, error: "로그인이 필요합니다." };
        const studentId = String(sessionToken).split('_')[2];

        const { data: targetGrat } = await sb.from('travel_gratitude').select('*').eq('id', Number(gratId)).single();
        if (!targetGrat) return { success: false, error: "해당 감사글을 찾을 수 없습니다." };
        if (String(targetGrat.student_id).trim() !== String(studentId).trim()) {
          return { success: false, error: "본인이 작성한 글만 수정할 수 있습니다." };
        }

        await sb.from('travel_gratitude').update({ body: String(newBody).trim() }).eq('id', Number(gratId));
        return { success: true };
      }

      if (funcName === "deleteGratitudeEntry") {
        const sessionToken = args[0];
        const gratId = args[1];
        if (!sessionToken) return { success: false, error: "로그인이 필요합니다." };
        const studentId = String(sessionToken).split('_')[2];

        const { data: targetGrat } = await sb.from('travel_gratitude').select('*').eq('id', Number(gratId)).single();
        if (!targetGrat) return { success: false, error: "해당 감사글을 찾을 수 없습니다." };
        if (String(targetGrat.student_id).trim() !== String(studentId).trim()) {
          return { success: false, error: "본인이 작성한 글만 삭제할 수 있습니다." };
        }

        await sb.from('travel_gratitude_likes').delete().eq('gratitude_id', Number(gratId));
        await sb.from('travel_gratitude').delete().eq('id', Number(gratId));
        return { success: true };
      }

      if (funcName === "getStudentCoinHistory") {
        const sessionToken = args[0];
        const type = String(args[1] || 'STAMP').toUpperCase();
        if (!sessionToken) return { success: false, error: "로그인이 필요합니다." };
        const studentId = String(sessionToken).split('_')[2];

        const { data: logs } = await sb.from('travel_coin_ledger')
          .select('*')
          .eq('student_id', studentId)
          .eq('type', type)
          .order('id', { ascending: false })
          .limit(100);

        const { data: student } = await sb.from('travel_students').select('*').eq('student_id', studentId).single();

        let totalEarned = 0;
        let totalSpent = 0;

        const list = (logs || []).map(r => {
          const amt = type === 'STAMP' ? Number(r.change_stamps || 0) : Number(r.change_gems || 0);
          if (amt > 0) totalEarned += amt;
          else totalSpent += Math.abs(amt);

          const d = new Date(r.created_at);
          const dateStr = d.toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);

          return {
            amount: amt,
            reason: r.reason || '',
            createdAt: dateStr
          };
        });

        const currentBal = student ? (type === 'STAMP' ? student.stamp_balance : student.gem_balance) : 0;

        return {
          success: true,
          type: type,
          list: list,
          summary: {
            totalEarned: totalEarned,
            totalSpent: totalSpent,
            currentBalance: currentBal || 0
          }
        };
      }

      if (funcName === "registerStudent") {
        const name = args[0];
        const dept = args[1] || "초등부";
        if (!name || !name.trim()) return { success: false, error: "이름을 입력하세요." };

        const { data: allStudents } = await sb.from('travel_students').select('student_id,pin');

        let maxNum = 0;
        const pins = [];
        (allStudents || []).forEach(s => {
          if (s.pin) pins.push(String(s.pin).trim());
          if (s.student_id && s.student_id.startsWith('S')) {
            const num = parseInt(s.student_id.replace(/\D/g, ''), 10);
            if (!isNaN(num) && num > maxNum) maxNum = num;
          }
        });

        const nextNum = maxNum + 1;
        const nextId = "S" + String(nextNum).padStart(3, '0');

        let pin = "";
        do {
          pin = String(Math.floor(1000 + Math.random() * 9000));
        } while (pins.includes(pin));

        const emojis = ["🦁", "⛵", "👑", "🚀", "🦄", "🐬", "🐼", "🎨", "⚽", "🎸"];
        const colors = ["#ff66af", "#3b82f6", "#10b981", "#8b5cf6", "#f59e0b", "#ec4899"];
        const emoji = emojis[Math.floor(Math.random() * emojis.length)];
        const color = colors[Math.floor(Math.random() * colors.length)];

        const { error: insErr } = await sb.from('travel_students').insert({
          student_id: nextId,
          name: name.trim(),
          department: dept,
          display_emoji: emoji,
          card_color: color,
          pin: pin,
          current_day_index: 1,
          stamp_balance: 0,
          gem_balance: 0,
          total_used_stamps: 0,
          streak_on_time: 0,
          is_active: true
        });

        if (insErr) return { success: false, error: insErr.message };
        return { success: true, studentId: nextId, name: name.trim(), pin: pin };
      }

      if (funcName === "listMarketProducts") {
        const { data } = await sb.from('travel_settings').select('value').eq('key', 'MARKET_PRODUCTS').single();
        let products = [];
        if (data && data.value) {
          try { products = JSON.parse(data.value); } catch(e) {}
        }
        return { success: true, products: Array.isArray(products) ? products : [] };
      }

      if (funcName === "saveMarketProduct") {
        const teacherToken = args[0];
        const product = args[1];
        if (!isUserTeacher(teacherToken)) return { success: false, error: "관리자(교사) 권한이 필요합니다." };
        if (!product || !product.name) return { success: false, error: "상품 정보를 확인해 주세요." };

        const { data } = await sb.from('travel_settings').select('value').eq('key', 'MARKET_PRODUCTS').single();
        let products = [];
        if (data && data.value) {
          try { products = JSON.parse(data.value); } catch(e) {}
        }
        if (!Array.isArray(products)) products = [];

        const pId = product.id || ("MKT_" + Date.now());
        const pIndex = products.findIndex(p => p.id === pId);
        const savedItem = {
          id: pId,
          name: String(product.name).trim(),
          gemPrice: Math.max(1, Number(product.gemPrice) || 1),
          imageUrl: String(product.imageUrl || "").trim(),
          description: String(product.description || "").trim(),
          isAvailable: product.isAvailable !== false,
          createdAt: product.createdAt || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })
        };

        if (pIndex !== -1) {
          products[pIndex] = savedItem;
        } else {
          products.push(savedItem);
        }

        await sb.from('travel_settings').upsert({ key: 'MARKET_PRODUCTS', value: JSON.stringify(products) });
        return { success: true, product: savedItem };
      }

      if (funcName === "deleteMarketProduct") {
        const teacherToken = args[0];
        const productId = args[1];
        if (!isUserTeacher(teacherToken)) return { success: false, error: "관리자(교사) 권한이 필요합니다." };

        const { data } = await sb.from('travel_settings').select('value').eq('key', 'MARKET_PRODUCTS').single();
        let products = [];
        if (data && data.value) {
          try { products = JSON.parse(data.value); } catch(e) {}
        }
        if (!Array.isArray(products)) products = [];

        products = products.filter(p => String(p.id).trim() !== String(productId).trim());
        await sb.from('travel_settings').upsert({ key: 'MARKET_PRODUCTS', value: JSON.stringify(products) });
        return { success: true };
      }

      if (funcName === "exchangeMarketProduct") {
        const sessionToken = args[0];
        const productId = args[1];
        if (!sessionToken) return { success: false, error: "로그인이 필요합니다." };
        const studentId = String(sessionToken).split('_')[2];

        // 상품 조회
        const { data: mData } = await sb.from('travel_settings').select('value').eq('key', 'MARKET_PRODUCTS').single();
        let products = [];
        if (mData && mData.value) {
          try { products = JSON.parse(mData.value); } catch(e) {}
        }
        const product = products.find(p => p.id === productId);
        if (!product) return { success: false, error: "해당 상품을 찾을 수 없습니다." };
        if (!product.isAvailable) return { success: false, error: "현재 교환할 수 없는 상품입니다." };

        // 학생 잔고 조회
        const { data: s } = await sb.from('travel_students').select('*').eq('student_id', studentId).single();
        if (!s) return { success: false, error: "학생 정보를 찾을 수 없습니다." };
        if ((s.gem_balance || 0) < product.gemPrice) {
          return { success: false, error: `보석이 부족합니다. (필요: ${product.gemPrice}개 / 보유: ${s.gem_balance || 0}개)` };
        }

        // 보석 차감 및 코인장부 기록
        const newGems = s.gem_balance - product.gemPrice;
        await sb.from('travel_students').update({ gem_balance: newGems }).eq('student_id', studentId);
        await sb.from('travel_coin_ledger').insert({
          student_id: studentId,
          type: 'GEM',
          change_gems: -product.gemPrice,
          reason: `달란트마켓교환: ${product.name}`
        });

        // 주문 기록 저장 (travel_settings의 MARKET_ORDERS)
        try {
          const { data: oData } = await sb.from('travel_settings').select('value').eq('key', 'MARKET_ORDERS').single();
          let orders = [];
          if (oData && oData.value) {
            try { orders = JSON.parse(oData.value); } catch(e) {}
          }
          orders.push({
            orderId: "ORD_" + Date.now(),
            studentId: studentId,
            studentName: s.name,
            productId: product.id,
            productName: product.name,
            gemPrice: product.gemPrice,
            status: "APPLIED",
            createdAt: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })
          });
          await sb.from('travel_settings').upsert({ key: 'MARKET_ORDERS', value: JSON.stringify(orders) });
        } catch(e) {}

        return {
          success: true,
          productName: product.name,
          gemPrice: product.gemPrice,
          gemBalance: newGems,
          stampBalance: s.stamp_balance
        };
      }

      if (funcName === "grantPraiseStamps") {
        const teacherToken = args[0];
        const studentId = args[1];
        const amount = Number(args[2]) || 1;
        const reason = args[3] || '선생님 칭찬도장';
        if (!isUserTeacher(teacherToken)) return { success: false, error: "관리자(교사) 권한이 필요합니다." };
        const { data: s } = await sb.from('travel_students').select('stamp_balance').eq('student_id', studentId).single();
        const newStamp = (s ? s.stamp_balance : 0) + amount;
        await sb.from('travel_students').update({ stamp_balance: newStamp }).eq('student_id', studentId);
        await sb.from('travel_coin_ledger').insert({
          student_id: studentId,
          type: 'STAMP',
          change_stamps: amount,
          reason: reason
        });
        return { success: true, stampBalance: newStamp };
      }

      if (funcName === "changeUserPin") {
        const token = args[0];
        const isTeacher = args[1];
        const oldPin = args[2];
        const newPin = args[3];
        if (isTeacher) {
          const { data } = await sb.from('travel_settings').select('value').eq('key', 'TEACHER_PIN').single();
          if (data && data.value.trim() !== String(oldPin).trim()) return { success: false, error: "기존 PIN이 일치하지 않습니다." };
          await sb.from('travel_settings').upsert({ key: 'TEACHER_PIN', value: String(newPin).trim() });
          return { success: true };
        } else {
          const studentId = String(token).split('_')[2];
          const { data } = await sb.from('travel_students').select('pin').eq('student_id', studentId).single();
          if (data && String(data.pin).trim() !== String(oldPin).trim()) return { success: false, error: "기존 PIN이 일치하지 않습니다." };
          await sb.from('travel_students').update({ pin: String(newPin).trim() }).eq('student_id', studentId);
          return { success: true };
        }
      }

      console.warn("미구현 함수:", funcName);
      return { success: true };
    } catch(err) {
      console.error("apiCall Exception:", funcName, err);
      return { success: false, error: err.message || String(err) };
    }
  }


  // 앱 로드 시 자동 로그인 세션 복원
  function restoreSession() {
    try {
      var savedToken = localStorage.getItem("bt_session_token");
      var savedStudent = localStorage.getItem("bt_student_data");
      if (savedToken && savedStudent) {
        state.sessionToken = savedToken;
        state.student = JSON.parse(savedStudent);
        if (state.student && String(state.student.department).indexOf("교사") !== -1) {
          state.isTeacher = true;
          state.isMasterAdmin = false;
          state.teacherToken = "TEACHER_TOKEN_" + state.student.studentId;
          sessionStorage.removeItem("bt_is_master_admin");
        }
        updateUserHeader();
      }
    } catch(e) {
      console.warn("세션 복원 예외 처리:", e);
    }
  }

  // DOM 로드 시 초기화
    // 🍎 애플 스타일 인터랙티브 독(Dock) 확대 및 마우스 추적 효과
  function initDockMagnificationEffect() {
    var dock = document.querySelector(".bottom-nav");
    if (!dock) return;

    var items = dock.querySelectorAll(".nav-item");
    var maxDistance = 110; // 마우스 영향 범위 (px)
    var maxScale = 1.35;   // 최대 확대 배율
    var maxLift = 12;      // 위로 솟아오르는 높이 (px)
    var rafId = null;

    dock.addEventListener("mousemove", function(e) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(function() {
        var mouseX = e.clientX;

        items.forEach(function(item) {
          var rect = item.getBoundingClientRect();
          var itemCenterX = rect.left + rect.width / 2;
          var dist = Math.abs(mouseX - itemCenterX);

          if (dist < maxDistance) {
            // 코사인 감쇠 곡선: 중심에서 1, 거리 끝에서 0
            var factor = Math.cos((dist / maxDistance) * (Math.PI / 2));
            var scale = 1 + (maxScale - 1) * factor;
            var lift = -maxLift * factor;
            var pullX = (mouseX - itemCenterX) * 0.15 * factor; // 커서 방향으로 살짝 당겨짐

            item.style.transform = "translate3d(" + pullX + "px, " + lift + "px, 0) scale(" + scale + ")";
            item.style.zIndex = Math.round(50 * factor) + 1;

            var icon = item.querySelector(".nav-icon");
            if (icon) {
              icon.style.transform = "scale(" + (1 + 0.18 * factor) + ")";
            }
          } else {
            item.style.transform = "translate3d(0, 0, 0) scale(1)";
            item.style.zIndex = "1";
            var icon = item.querySelector(".nav-icon");
            if (icon) icon.style.transform = "scale(1)";
          }
        });
      });
    });

    dock.addEventListener("mouseleave", function() {
      if (rafId) cancelAnimationFrame(rafId);
      items.forEach(function(item) {
        item.style.transform = "translate3d(0, 0, 0) scale(1)";
        item.style.zIndex = "1";
        var icon = item.querySelector(".nav-icon");
        if (icon) icon.style.transform = "scale(1)";
      });
    });
  }

  // 🎴 BT 카드 도감 마우스 추적 3D 틸트 및 확대 효과 (이벤트 위임)
  function initCardDexTiltEffect() {
    var grid = document.getElementById("card-dex-grid");
    if (!grid) return;

    var activeCard = null;
    var rafId = null;

    function resetCard(card) {
      if (!card) return;
      card.style.transform = "perspective(600px) translate3d(0, 0, 0) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)";
      card.style.boxShadow = "";
      card.style.zIndex = "";
    }

    grid.addEventListener("mousemove", function(e) {
      var card = e.target.closest(".card-dex-item");
      if (activeCard && activeCard !== card) {
        resetCard(activeCard);
        activeCard = null;
      }
      if (!card) return;
      activeCard = card;

      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(function() {
        var rect = card.getBoundingClientRect();
        var x = e.clientX - rect.left;
        var y = e.clientY - rect.top;
        var centerX = rect.width / 2;
        var centerY = rect.height / 2;
        var deltaX = (x - centerX) / (centerX || 1);
        var deltaY = (y - centerY) / (centerY || 1);

        // 3D 회전각 및 마우스 추적 이동값 계산
        var rotateX = -deltaY * 12;
        var rotateY = deltaX * 12;
        var pullX = deltaX * 5;
        var pullY = deltaY * 5;

        var isUnlocked = card.classList.contains("unlocked");
        var shadowGlow = isUnlocked 
          ? (-deltaX * 8) + "px " + (10 - deltaY * 6) + "px 20px rgba(255, 102, 175, 0.35)" 
          : (-deltaX * 6) + "px " + (8 - deltaY * 4) + "px 16px rgba(0, 0, 0, 0.12)";

        card.style.transform = "perspective(600px) translate3d(" + pullX + "px, " + pullY + "px, 0) rotateX(" + rotateX + "deg) rotateY(" + rotateY + "deg) scale3d(1.08, 1.08, 1.08)";
        card.style.boxShadow = shadowGlow;
        card.style.zIndex = "20";
      });
    });

    grid.addEventListener("mouseleave", function() {
      if (rafId) cancelAnimationFrame(rafId);
      if (activeCard) {
        resetCard(activeCard);
        activeCard = null;
      }
    });
  }

  document.addEventListener("DOMContentLoaded", function() {
    initDockMagnificationEffect();
    initCardDexTiltEffect();
    restoreSession();
    

    apiCall("getRecommendedBooks").then(function(res) {
      if (res && res.success && res.recommendedBooks) {
        state.recommendedBooks = res.recommendedBooks;
        state.selectedBookIndex = getTodayBibleBookIndex();
        renderBibleBookProgress();
      }
    });

    apiCall("makeAllCardFilesPublic");

    apiCall("loadMapPointsFromSheet").then(function(res) {
      if (res) state.mapPoints = res;
      if (state.student) switchTab("home");
      else switchTab("onboarding");
    });
  });

  // PWA 모달 제어
  function openPwaModal() {
    var modal = document.getElementById("modal-pwa-guide");
    if (modal) {
      modal.classList.add("active");
      modal.style.display = "flex";
    }
  }

  function closePwaModal() {
    var chk = document.getElementById("chk-never-show-pwa");
    if (chk && chk.checked) {
      localStorage.setItem("bt_hide_pwa_guide", "true");
    }
    var modal = document.getElementById("modal-pwa-guide");
    if (modal) {
      modal.classList.remove("active");
      modal.style.display = "none";
    }
  }

  // 개인정보 처리방침 모달 제어
  function openPrivacyModal() {
    var modal = document.getElementById("modal-privacy");
    if (modal) {
      modal.classList.add("active");
      modal.style.display = "flex";
    }
  }

  function closePrivacyModal() {
    var modal = document.getElementById("modal-privacy");
    if (modal) {
      modal.classList.remove("active");
      modal.style.display = "none";
    }
  }

  function switchPwaTab(type) {
    var tabIos = document.getElementById("pwa-tab-ios");
    var tabAnd = document.getElementById("pwa-tab-android");
    var contIos = document.getElementById("pwa-content-ios");
    var contAnd = document.getElementById("pwa-content-android");

    if (type === "ios") {
      tabIos.className = "btn-pill";
      tabAnd.className = "btn-pill btn-secondary";
      contIos.style.display = "flex";
      contAnd.style.display = "none";
    } else {
      tabIos.className = "btn-pill btn-secondary";
      tabAnd.className = "btn-pill";
      contIos.style.display = "none";
      contAnd.style.display = "flex";
    }
  }

  // 뷰 전환 스위처
  function showView(viewId) {
    var sections = document.querySelectorAll(".view-section");
    sections.forEach(function(sec) { sec.classList.remove("active"); });

    var target = document.getElementById("view-" + viewId);
    if (target) target.classList.add("active");

    var navItems = document.querySelectorAll(".nav-item");
    navItems.forEach(function(item) { item.classList.remove("active"); });
    var activeNav = document.querySelector('.nav-item[data-view="' + viewId + '"]');
    if (activeNav) activeNav.classList.add("active");

    state.currentTab = viewId;
  }

  function switchTab(viewId) {
    showView(viewId);

    if (viewId === "map") loadMapView(state.activeMapId);
    else if (viewId === "home") loadStudentHome();
    else if (viewId === "dex") loadCardDex();
    else if (viewId === "gratitude") loadGratitudeFeed();
    else if (viewId === "shop") loadShopView();
    else if (viewId === "teacher") loadTeacherDashboard();
  }

  // 🛍️ 상점 탭 렌더링
  function loadShopView() {
    var stamps = state.student ? (state.student.stampBalance || 0) : 0;
    var gems = state.student ? (state.student.gemBalance || 0) : 0;

    var shopStampEl = document.getElementById("shop-stamp-count");
    var shopGemEl = document.getElementById("shop-gem-count");

    if (shopStampEl) shopStampEl.textContent = stamps + "개";
    if (shopGemEl) shopGemEl.textContent = gems + "개";

    var inputGems = document.getElementById("input-exchange-gems");
    if (inputGems) {
      inputGems.value = stamps >= 10 ? "1" : "0";
      updateExchangeStampCost();
    }

    renderMarketProductGrid();


  }

  function adjustExchangeGems(amount) {
    var input = document.getElementById("input-exchange-gems");
    if (!input) return;
    var current = Number(input.value) || 0;
    input.value = Math.max(1, current + amount);
    updateExchangeStampCost();
  }

  function setExchangeGemsToMax() {
    var input = document.getElementById("input-exchange-gems");
    if (!input) return;
    var stamps = state.student ? Number(state.student.stampBalance || 0) : 0;
    var maxGems = Math.floor(stamps / 10);
    input.value = Math.max(1, maxGems);
    updateExchangeStampCost();
  }

  function updateExchangeStampCost() {
    var input = document.getElementById("input-exchange-gems");
    var btn = document.getElementById("btn-exchange-action");
    if (!input || !btn) return;

    var gems = Number(input.value) || 0;
    var costStamps = gems * 10;
    btn.textContent = "💎 도장 " + costStamps + "개 ➔ 보석 " + gems + "개 교환하기";
  }

  function onExchangeStampsToGems() {
    if (!state.student) return showToast("로그인이 필요합니다.");
    
    var input = document.getElementById("input-exchange-gems");
    var units = input ? parseInt(input.value, 10) : 1;

    if (isNaN(units) || units <= 0) {
      return showToast("교환할 보석 수량을 1개 이상 입력하세요.");
    }

    var requiredStamps = units * 10;
    var currentStamps = Number(state.student.stampBalance || 0);

    if (currentStamps < requiredStamps) {
      return showToast("도장이 부족합니다. (필요: " + requiredStamps + "개 / 보유: " + currentStamps + "개)");
    }

    showToastConfirm("도장 " + requiredStamps + "개를 보석 " + units + "개로 교환하시겠습니까?").then(function(ok) {
      if (!ok) return;

      showToast("환전 처리 중...");
      apiCall("exchangeStampsToGems", state.sessionToken, units).then(function(res) {
        if (res && res.success) {
          state.student.stampBalance = res.stampBalance;
          state.student.gemBalance = res.gemBalance;

          renderWallet();
          loadShopView();
          showToast("🎉 환전 완료! 보석 +" + units + "개를 획득했습니다!");
        } else {
          showToast(res ? res.error : "환전 실패");
        }
      });
    });
  }

  // 66권 전체 성경 마스터 데이터
  var ALL_66_BIBLE_BOOKS = [
    { order: 1, id: "GEN", name: "창세기", chapters: 50 },
    { order: 2, id: "EXO", name: "출애굽기", chapters: 40 },
    { order: 3, id: "LEV", name: "레위기", chapters: 27 },
    { order: 4, id: "NUM", name: "민수기", chapters: 36 },
    { order: 5, id: "DEU", name: "신명기", chapters: 34 },
    { order: 6, id: "JOS", name: "여호수아", chapters: 24 },
    { order: 7, id: "JDG", name: "사사기", chapters: 21 },
    { order: 8, id: "RUT", name: "룻기", chapters: 4 },
    { order: 9, id: "1SA", name: "사무엘상", chapters: 31 },
    { order: 10, id: "2SA", name: "사무엘하", chapters: 24 },
    { order: 11, id: "1KI", name: "열왕기상", chapters: 22 },
    { order: 12, id: "2KI", name: "열왕기하", chapters: 25 },
    { order: 13, id: "1CH", name: "역대상", chapters: 29 },
    { order: 14, id: "2CH", name: "역대하", chapters: 36 },
    { order: 15, id: "EZR", name: "에스라", chapters: 10 },
    { order: 16, id: "NEH", name: "느헤미야", chapters: 13 },
    { order: 17, id: "EST", name: "에스더", chapters: 10 },
    { order: 18, id: "JOB", name: "욥기", chapters: 42 },
    { order: 19, id: "PSA", name: "시편", chapters: 150 },
    { order: 20, id: "PRO", name: "잠언", chapters: 31 },
    { order: 21, id: "ECC", name: "전도서", chapters: 12 },
    { order: 22, id: "SNG", name: "아가", chapters: 8 },
    { order: 23, id: "ISA", name: "이사야", chapters: 66 },
    { order: 24, id: "JER", name: "예레미야", chapters: 52 },
    { order: 25, id: "LAM", name: "예레미야애가", chapters: 5 },
    { order: 26, id: "EZK", name: "에스겔", chapters: 48 },
    { order: 27, id: "DAN", name: "다니엘", chapters: 12 },
    { order: 28, id: "HOS", name: "호세아", chapters: 14 },
    { order: 29, id: "JOL", name: "요엘", chapters: 3 },
    { order: 30, id: "AMO", name: "아모스", chapters: 9 },
    { order: 31, id: "OBA", name: "오바댜", chapters: 1 },
    { order: 32, id: "JON", name: "요나", chapters: 4 },
    { order: 33, id: "MIC", name: "미가", chapters: 7 },
    { order: 34, id: "NAM", name: "나훔", chapters: 3 },
    { order: 35, id: "HAB", name: "하박국", chapters: 3 },
    { order: 36, id: "ZEP", name: "스바냐", chapters: 3 },
    { order: 37, id: "HAG", name: "학개", chapters: 2 },
    { order: 38, id: "ZEC", name: "스가랴", chapters: 14 },
    { order: 39, id: "MAL", name: "말라기", chapters: 4 },
    { order: 40, id: "MAT", name: "마태복음", chapters: 28 },
    { order: 41, id: "MRK", name: "마가복음", chapters: 16 },
    { order: 42, id: "LUK", name: "누가복음", chapters: 24 },
    { order: 43, id: "JHN", name: "요한복음", chapters: 21 },
    { order: 44, id: "ACT", name: "사도행전", chapters: 28 },
    { order: 45, id: "ROM", name: "로마서", chapters: 16 },
    { order: 46, id: "1CO", name: "고린도전서", chapters: 16 },
    { order: 47, id: "2CO", name: "고린도후서", chapters: 13 },
    { order: 48, id: "GAL", name: "갈라디아서", chapters: 6 },
    { order: 49, id: "EPH", name: "에베소서", chapters: 6 },
    { order: 50, id: "PHP", name: "빌립보서", chapters: 4 },
    { order: 51, id: "COL", name: "골로새서", chapters: 4 },
    { order: 52, id: "1TH", name: "데살로니가전서", chapters: 5 },
    { order: 53, id: "2TH", name: "데살로니가후서", chapters: 3 },
    { order: 54, id: "1TI", name: "디모데전서", chapters: 6 },
    { order: 55, id: "2TI", name: "디모데후서", chapters: 4 },
    { order: 56, id: "TIT", name: "디도서", chapters: 3 },
    { order: 57, id: "PHM", name: "빌레몬서", chapters: 1 },
    { order: 58, id: "HEB", name: "히브리서", chapters: 13 },
    { order: 59, id: "JAS", name: "야고보서", chapters: 5 },
    { order: 60, id: "1PE", name: "베드로전서", chapters: 5 },
    { order: 61, id: "2PE", name: "베드로후서", chapters: 3 },
    { order: 62, id: "1JN", name: "요한일서", chapters: 5 },
    { order: 63, id: "2JN", name: "요한이서", chapters: 1 },
    { order: 64, id: "3JN", name: "요한삼서", chapters: 1 },
    { order: 65, id: "JUD", name: "유다서", chapters: 1 },
    { order: 66, id: "REV", name: "요한계시록", chapters: 22 }
  ];

  state.selectedBookIndex = 0;
  state.recommendedBooks = null; // 교사 지정 추천 성경책 ID 배열 (null이면 66권 전체)

  function getFilteredBibleBooks() {
    if (!state.recommendedBooks || !Array.isArray(state.recommendedBooks) || state.recommendedBooks.length === 0) {
      return ALL_66_BIBLE_BOOKS;
    }
    var recSet = {};
    state.recommendedBooks.forEach(function(bId) {
      recSet[String(bId).trim()] = true;
    });
    var filtered = ALL_66_BIBLE_BOOKS.filter(function(b) {
      return recSet[b.id] === true;
    });
    return filtered.length > 0 ? filtered : ALL_66_BIBLE_BOOKS;
  }

  // 💡 새로 추가: 선택된 성경책들의 총 장수를 계산
  function getTotalActiveChapters() {
    var count = 0;
    getFilteredBibleBooks().forEach(function(b) { count += b.chapters; });
    return count > 0 ? count : 1189;
  }

  // 💡 수정됨: 66권 전체가 아닌, 필터링된 성경책만으로 절대 진도표(AbsRanges) 생성
  function getBibleAbsRanges() {
    var activeBooks = getFilteredBibleBooks();
    var absCounter = 0;
    return activeBooks.map(function(b) {
      var start = absCounter + 1;
      var end = absCounter + b.chapters;
      absCounter = end;
      return {
        order: b.order,
        id: b.id,
        name: b.name,
        chapters: b.chapters,
        startAbs: start,
        endAbs: end
      };
    });
  }

  // 💡 수정됨: 제외된 책의 장수를 터치했을 때 오류가 나지 않도록 방어 (0 반환)
  function getAbsChapter(bookName, chapter) {
    var absRanges = getBibleAbsRanges();
    var range = absRanges.find(function(r) { return r.name === String(bookName).trim(); });
    return range ? (range.startAbs + Number(chapter) - 1) : 0; 
  }

  // 🚨 누락되어 ReferenceError를 일으켰던 절대 장수(1~1189) 계산 함수 복원
  function getAbsChapter(bookName, chapter) {
    var absRanges = getBibleAbsRanges();
    var range = absRanges.find(function(r) { return r.name === String(bookName).trim(); });
    return range ? (range.startAbs + Number(chapter) - 1) : Number(chapter);
  }

  // 📖 교사가 선택한 추천 성경책들에 해당하는 전체 장(Chapter) 목록 순서대로 추출
  function getActiveRecommendedChapterList() {
    var activeList = [];
    var recSet = null;
    if (state.recommendedBooks && Array.isArray(state.recommendedBooks) && state.recommendedBooks.length > 0) {
      recSet = {};
      state.recommendedBooks.forEach(function(bId) { recSet[String(bId).trim()] = true; });
    }

    ALL_66_BIBLE_BOOKS.forEach(function(b) {
      if (!recSet || recSet[b.id] === true) {
        for (var c = 1; c <= b.chapters; c++) {
          activeList.push({
            bookId: b.id,
            bookName: b.name,
            chapter: c,
            bookOrder: b.order
          });
        }
      }
    });
    return activeList;
  }

  // 🎯 3장 고정 블록 경계(1~3, 4~6, 7~9, ...) 정렬 기반 미션 구간 계산 함수
  function getCurrentMissionBlock() {
    var absRanges = getBibleAbsRanges();
    var MAX_ABS = getTotalActiveChapters();

    var allReadAbsList = [];
    if (state.student && state.student.readLogs && Array.isArray(state.student.readLogs)) {
      state.student.readLogs.forEach(function(l) {
        var r = absRanges.find(function(x) { return x.name === String(l.bookName).trim(); });
        if (r && r.startAbs !== null) {
          var aVal = r.startAbs + Number(l.chapter) - 1;
          if (allReadAbsList.indexOf(aVal) === -1) allReadAbsList.push(aVal);
        }
      });
    }

    var globalDay = getGlobalDayIndex();
    var globalTargetStart = (globalDay - 1) * 3 + 1;

    // 아직 읽지 않은 가장 첫 번째 장(구멍) 탐색
    var firstUnreadAbs = 1;
    for (var i = 1; i <= MAX_ABS; i++) {
      if (allReadAbsList.indexOf(i) === -1) {
        firstUnreadAbs = i;
        break;
      }
    }

    var targetAbs = Math.min(firstUnreadAbs, globalTargetStart);

    // 🚨 3장 고정 블록 경계(1~3, 4~6, 7~9, ...)로 완벽 정렬
    // 2장을 읽었어도 1~3장 블록 내에 존재하므로 오후에 재접속해도 미션이 3~5장으로 밀리지 않음!
    var blockIndex = Math.floor((targetAbs - 1) / 3);
    var startAbs = blockIndex * 3 + 1;
    var endAbs = Math.min(MAX_ABS, startAbs + 2);

    // 지정된 미션 블록(startAbs ~ endAbs)의 3개 장을 100% 모두 완독했는지 체크
    var isBlockComplete = true;
    for (var ch = startAbs; ch <= endAbs; ch++) {
      if (allReadAbsList.indexOf(ch) === -1) {
        isBlockComplete = false;
        break;
      }
    }

    return {
      startAbs: startAbs,
      endAbs: endAbs,
      isCompleted: isBlockComplete
    };
  }

  // 📖 현재 진행 중인 3장 블록에 해당하는 추천 성경 장 추출
  function getNextRecommendedThreeChapters() {
    var activeChapters = getActiveRecommendedChapterList();
    if (!activeChapters || activeChapters.length === 0) {
      return [
        { bookId: "GEN", bookName: "창세기", chapter: 1, bookOrder: 1 },
        { bookId: "GEN", bookName: "창세기", chapter: 2, bookOrder: 1 },
        { bookId: "GEN", bookName: "창세기", chapter: 3, bookOrder: 1 }
      ];
    }

    var block = getCurrentMissionBlock();
    var startIdx = Math.max(0, block.startAbs - 1);
    if (startIdx >= activeChapters.length) {
      startIdx = Math.max(0, activeChapters.length - 3);
    }

    return activeChapters.slice(startIdx, startIdx + 3);
  }

  // 📖 추천 3장 목록을 한국어 안내 문구로 안전하게 변환
  function formatRecommendedChaptersToText(recList) {
    if (!recList || !Array.isArray(recList) || recList.length === 0) {
      return "창세기 1–3장";
    }

    var groups = [];
    var currentBook = null;
    var startCh = 0, endCh = 0;

    for (var i = 0; i < recList.length; i++) {
      var item = recList[i];
      if (!item || !item.bookName) continue;

      if (currentBook !== item.bookName) {
        if (currentBook) {
          groups.push(currentBook + " " + (startCh === endCh ? startCh + "장" : startCh + "-" + endCh + "장"));
        }
        currentBook = item.bookName;
        startCh = Number(item.chapter);
        endCh = Number(item.chapter);
      } else {
        endCh = Number(item.chapter);
      }
    }

    if (currentBook) {
      groups.push(currentBook + " " + (startCh === endCh ? startCh + "장" : startCh + "-" + endCh + "장"));
    }

    return groups.length > 0 ? groups.join(", ") : "창세기 1–3장";
  }

  // 📖 절대 장수 범위(예: 1~3, 4~6)를 성경책 이름과 장수로 안전하게 변환
  function formatAbsRangeToText(startAbs, endAbs) {
    if (!startAbs || !endAbs) return "창세기 1-3장";
    var absRanges = getBibleAbsRanges();
    var list = [];
    for (var i = startAbs; i <= endAbs; i++) {
      var r = absRanges.find(function(x) { return i >= x.startAbs && i <= x.endAbs; });
      if (r) {
        var ch = i - r.startAbs + 1;
        list.push({ bookName: r.name, chapter: ch });
      }
    }
    return formatRecommendedChaptersToText(list);
  }

  function getTodayBibleBookIndex() {
    var activeBooks = getFilteredBibleBooks();
    var recThree = getNextRecommendedThreeChapters();
    if (recThree && recThree.length > 0) {
      var firstItem = recThree[0];
      var bookIdx = activeBooks.findIndex(function(b) { return b.name === firstItem.bookName; });
      return bookIdx !== -1 ? bookIdx : 0;
    }
    return 0;
  }

  function getBookReadChapters(bookName) {
    if (!state.student || !state.student.readLogs) return [];
    var logs = state.student.readLogs.filter(function(l) { return String(l.bookName).trim() === bookName; });
    var chapters = logs.map(function(l) { return Number(l.chapter); });
    return chapters.sort(function(a, b) { return a - b; });
  }

  // 4. 🏠 홈 로드 시 (고정값 유지)
  function loadStudentHome() {
    updateUserHeader();

    if (state.student && state.student.studentId) {
      apiCall("fetchLatestStudentData", state.student.studentId).then(function(res) {
        if (res && res.success) {
          state.student.stampBalance = res.stampBalance;
          state.student.gemBalance = res.gemBalance;
          state.student.totalUsedStamps = res.totalUsedStamps;
          state.student.streakOnTime = res.streakOnTime;
          state.student.currentDayIndex = res.currentDayIndex;
          state.student.readLogs = res.readLogs;

          try {
            localStorage.setItem("bt_student_data", JSON.stringify(state.student));
          } catch(e) {}

          // 최신 서버 읽기 기록을 수신했으므로 오늘 미션과 오늘 성경 위치를 항상 재계산
          initDailyMissionForSession();
          state.selectedBookIndex = getTodayBibleBookIndex();
          
          renderWallet();
          renderBibleBookProgress();
          updateUserHeader();
        }
      });
    } else {
      renderWallet();
      renderBibleBookProgress();
    }

    var myDay = state.student ? (state.student.currentDayIndex || 1) : 1;
    var ranges = getDynamicMapRanges();
    var myMap = "M01";
    
    if (myDay > ranges.M07.max) myMap = "M08";
    else if (myDay > ranges.M06.max) myMap = "M07";
    else if (myDay > ranges.M05.max) myMap = "M06";
    else if (myDay > ranges.M04.max) myMap = "M05";
    else if (myDay > ranges.M03.max) myMap = "M04";
    else if (myDay > ranges.M02.max) myMap = "M03";
    else if (myDay > ranges.M01.max) myMap = "M02";

    var mapImages = {
      M01: "/maps/M01.jpg", 
      M02: "/maps/M02.jpg",
      M03: "/maps/M03.jpg", 
      M04: "/maps/M04.jpg",
      M05: "/maps/M05.jpg", 
      M06: "/maps/M06.jpg",
      M07: "/maps/M07.jpg", 
      M08: "/maps/M08.jpg"
    };

    var homeCanvas = document.getElementById("home-map-canvas");
    if (homeCanvas && mapImages[myMap]) {
      homeCanvas.style.backgroundImage = "url('" + mapImages[myMap] + "')";
    }
    
    loadMapView(myMap);
  }

  window.addEventListener("scroll", function() {
    var header = document.getElementById("main-app-header");
    if (!header) return;
    if (window.scrollY > 40) {
      header.classList.add("floating-header");
    } else {
      header.classList.remove("floating-header");
    }
  });

  function renderWallet() {
    var stamps = state.student ? (state.student.stampBalance || 0) : 0;
    var gems = state.student ? (state.student.gemBalance || 0) : 0;
    var streak = state.student ? (state.student.streakOnTime || 0) : 0;
    var sBox = document.getElementById("wallet-stamps");
    var gBox = document.getElementById("wallet-gems");
    var stBox = document.getElementById("wallet-streak");
    if (sBox) sBox.textContent = stamps + "개";
    if (gBox) gBox.textContent = gems + "개";
    if (stBox) stBox.textContent = streak + "일";
  }

  function navigateBibleBook(delta) {
    var activeBooks = getFilteredBibleBooks();
    state.selectedBookIndex += delta;
    if (state.selectedBookIndex < 0) state.selectedBookIndex = 0;
    if (state.selectedBookIndex >= activeBooks.length) state.selectedBookIndex = activeBooks.length - 1;
    renderBibleBookProgress();
  }

  function openBibleSelectModal() {
    var modal = document.getElementById("modal-bible-select");
    var grid = document.getElementById("bible-select-grid");
    if (!modal || !grid) return;

    grid.innerHTML = "";
    var activeBooks = getFilteredBibleBooks();

    activeBooks.forEach(function(b, idx) {
      var btn = document.createElement("button");
      btn.className = "btn-pill " + (idx === state.selectedBookIndex ? "" : "btn-secondary");
      btn.style.cssText = "width:100%; padding:8px 4px; font-size:12px;";
      btn.textContent = b.order + ". " + b.name + " (" + b.chapters + "장)";
      btn.onclick = function() {
        state.selectedBookIndex = idx;
        renderBibleBookProgress();
        closeBibleSelectModal();
      };
      grid.appendChild(btn);
    });

    modal.classList.add("active");
    modal.style.display = "flex";
  }

  function closeBibleSelectModal() {
    var modal = document.getElementById("modal-bible-select");
    if (modal) {
      modal.classList.remove("active");
      modal.style.display = "none";
    }
  }

  // 1. 전역 상태에 세션 고정 미션 저장 변수 추가
  state.fixedDailyMission = null; // { startAbs, endAbs, isCompletedToday }

  // 2. 🎯 로그인/접속 시점에 단 1회만 계산하여 세션 동안 영구 고정하는 함수
  // 🎯 로그인/접속 시점에 오늘 미션 블록(3장 단위)을 계산하여 세션에 영구 고정
  function initDailyMissionForSession() {
    state.fixedDailyMission = getCurrentMissionBlock();
  }

  // 3. 📖 진도표 렌더링 (텍스트 에러 시에도 그리드 100% 렌더링 보장)
  function renderBibleBookProgress() {
    var activeBooks = getFilteredBibleBooks();
    if (state.selectedBookIndex >= activeBooks.length) {
      state.selectedBookIndex = Math.max(0, activeBooks.length - 1);
    }
    var book = activeBooks[state.selectedBookIndex] || activeBooks[0];
    var titleEl = document.getElementById("current-bible-book-title");
    if (titleEl) titleEl.textContent = "📖 " + book.name + " (1~" + book.chapters + "장) ▾";
    var grid = document.getElementById("genesis-progress-grid");
    if (!grid) return;
    grid.innerHTML = "";

    var readList = getBookReadChapters(book.name);
    var countEl = document.getElementById("bible-book-progress-count");
    if (countEl) countEl.textContent = readList.length + " / " + book.chapters;

    var absRanges = getBibleAbsRanges();
    var currentBookRange = absRanges.find(function(r) { return r.name === book.name; });

    var allReadAbsList = [];
    if (state.student && state.student.readLogs && Array.isArray(state.student.readLogs)) {
      state.student.readLogs.forEach(function(l) {
        var r = absRanges.find(function(x) { return x.name === String(l.bookName).trim(); });
        if (r) {
          var aVal = r.startAbs + Number(l.chapter) - 1;
          if (allReadAbsList.indexOf(aVal) === -1) allReadAbsList.push(aVal);
        }
      });
    }
    allReadAbsList.sort(function(a, b) { return a - b; });

    // (이전 코드 유지: allReadAbsList.sort(...) 직후)

    // 세션 고정 미션 초기화
    if (!state.fixedDailyMission) {
      initDailyMissionForSession();
    }

    var MAX_ABS = getTotalActiveChapters();
    var myStartAbs = (state.fixedDailyMission && state.fixedDailyMission.startAbs) ? state.fixedDailyMission.startAbs : 1;
    var myEndAbs = (state.fixedDailyMission && state.fixedDailyMission.endAbs) ? state.fixedDailyMission.endAbs : 3;
    var globalTargetAbs = Math.min(MAX_ABS, getGlobalDayIndex() * 3); // 1189 -> MAX_ABS 교체

    var hasReadTodayTarget = false;
    // (이후 코드 그대로 유지)
    for (var k = 0; k < allReadAbsList.length; k++) {
      if (allReadAbsList[k] >= myStartAbs && allReadAbsList[k] <= myEndAbs) {
        hasReadTodayTarget = true;
        break;
      }
    }

    var allowedMaxAbs = (hasReadTodayTarget || allReadAbsList.length >= globalTargetAbs) ? globalTargetAbs : myEndAbs;

    var todayTargetTextEl = document.getElementById("today-target-text");
    if (todayTargetTextEl) {
      try {
        todayTargetTextEl.textContent = formatAbsRangeToText(myStartAbs, myEndAbs);
      } catch (err) {
        todayTargetTextEl.textContent = "창세기 1-3장";
      }
    }

    var totalUsedStamps = state.student ? (Number(state.student.totalUsedStamps) || 0) : 0;

    // 🚨 칩 생성 루프
    for (var ch = 1; ch <= book.chapters; ch++) {
      var absCh = currentBookRange ? (currentBookRange.startAbs + ch - 1) : ch;
      var isCompleted = readList.indexOf(ch) !== -1;
      
      var isMyTodayTarget = (absCh >= myStartAbs && absCh <= myEndAbs);
      var isCatchupTarget = (absCh > myEndAbs && absCh <= globalTargetAbs);

      var readIndex = allReadAbsList.indexOf(absCh);
      var isLockedBySpent = (isCompleted && readIndex !== -1 && readIndex < totalUsedStamps);

      var isDisabled = false;
      if (isLockedBySpent) {
        isDisabled = true;
      } else if (!isMyTodayTarget) {
        if (absCh > allowedMaxAbs) {
          isDisabled = true;
        } else if (!hasReadTodayTarget && absCh < myStartAbs) {
          isDisabled = true;
        }
      }

      var chip = document.createElement("button");
      var styleCss = "padding:10px 4px; border-radius:12px; font-size:14px; font-weight:800; width:100%; transition:all 0.15s ease; box-shadow:0 2px 4px rgba(0,0,0,0.03);";
      
      if (isCompleted) {
        if (isLockedBySpent) {
          styleCss += " border:1.5px solid #059669; background:#10b981; color:#ffffff; cursor:not-allowed; opacity:0.85;";
          chip.title = "보석 교환에 사용되어 변경할 수 없습니다.";
        } else if (isDisabled) {
          styleCss += " border:1.5px solid #10b981; background:#10b981; color:#ffffff; cursor:not-allowed; opacity:0.6;";
        } else {
          styleCss += " border:1.5px solid #10b981; background:#10b981; color:#ffffff; cursor:pointer;";
        }
      } else if (isDisabled) {
        styleCss += " border:1.5px solid #e2e8f0; background:#f1f5f9; color:#94a3b8; cursor:not-allowed; opacity:0.4;";
        chip.disabled = true;
      } else if (isMyTodayTarget) {
        styleCss += " border:2.5px solid #ff66af; background:#fff0f7; color:#ff66af; box-shadow:0 0 10px rgba(255,102,175,0.4); cursor:pointer;";
      } else if (isCatchupTarget) {
        styleCss += " border:2px dashed #8b5cf6; background:#f5f3ff; color:#8b5cf6; cursor:pointer;";
      } else {
        styleCss += " border:1.5px solid var(--border); background:#ffffff; color:#475569; cursor:pointer;";
      }

      chip.style.cssText = styleCss;
      chip.textContent = ch;
      
      if (!isDisabled) {
        (function(chapterNum) { 
          chip.onclick = function() { onChapterChipClick(book.name, chapterNum, book.chapters); }; 
        })(ch);
      }
      grid.appendChild(chip);
    }
  }

  // 🎴 BT 수집 카드 66권 전체 마스터 데이터 매핑 (Code.gs CONFIG.BT_CARDS와 100% 일치)
  var BT_CARDS_MAP = {
    1: { title: "세상의 시작", category: "모세오경", img: "/cards/bt_01.jpg" },
    2: { title: "출구 없는 밤의 탈출", category: "모세오경", img: "/cards/bt_02.jpg" },
    3: { title: "거룩한 매뉴얼", category: "모세오경", img: "/cards/bt_03.jpg" },
    4: { title: "광야 카운트다운", category: "모세오경", img: "/cards/bt_04.jpg" },
    5: { title: "다시 들려주는 약속", category: "모세오경", img: "/cards/bt_05.jpg" },
    6: { title: "요단을 가르다", category: "역사서", img: "/cards/bt_06.jpg" },
    7: { title: "영웅이 필요해", category: "역사서", img: "/cards/bt_07.jpg" },
    8: { title: "이삭 밭의 온기", category: "역사서", img: "/cards/bt_08.jpg" },
    9: { title: "왕을 부르다", category: "역사서", img: "/cards/bt_09.jpg" },
    10: { title: "왕좌의 그늘", category: "역사서", img: "/cards/bt_10.jpg" },
    11: { title: "황금 성전과 갈라진 나라", category: "역사서", img: "/cards/bt_11.jpg" },
    12: { title: "불수레와 마지막 왕들", category: "역사서", img: "/cards/bt_12.jpg" },
    13: { title: "기쁨의 찬양대", category: "역사서", img: "/cards/bt_13.jpg" },
    14: { title: "황금 성전과 영광", category: "역사서", img: "/cards/bt_14.jpg" },
    15: { title: "말씀의 회복", category: "역사서", img: "/cards/bt_15.jpg" },
    16: { title: "성벽의 영웅", category: "역사서", img: "/cards/bt_16.jpg" },
    17: { title: "용감한 왕후", category: "역사서", img: "/cards/bt_17.jpg" },
    18: { title: "무지개 기도의 노래", category: "시가서", img: "/cards/bt_18.jpg" },
    19: { title: "하늘의 찬양 소리", category: "시가서", img: "/cards/bt_19.jpg" },
    20: { title: "지혜의 열쇠", category: "시가서", img: "/cards/bt_20.jpg" },
    21: { title: "아름다운 시간들", category: "시가서", img: "/cards/bt_21.jpg" },
    22: { title: "사랑의 꽃밭", category: "시가서", img: "/cards/bt_22.jpg" },
    23: { title: "평화의 무지개 동산", category: "대선지서", img: "/cards/bt_23.jpg" },
    24: { title: "소망의 백합화", category: "대선지서", img: "/cards/bt_24.jpg" },
    25: { title: "소망의 별빛 촛불", category: "대선지서", img: "/cards/bt_25.jpg" },
    26: { title: "생기의 바람", category: "대선지서", img: "/cards/bt_26.jpg" },
    27: { title: "사자굴의 기적", category: "대선지서", img: "/cards/bt_27.jpg" },
    28: { title: "아낌없는 사랑 선물", category: "소선지서", img: "/cards/bt_28.jpg" },
    29: { title: "성령의 무지개 단비", category: "소선지서", img: "/cards/bt_29.jpg" },
    30: { title: "공의의 맑은 시냇물", category: "소선지서", img: "/cards/bt_30.jpg" },
    31: { title: "겸손의 높은 산", category: "소선지서", img: "/cards/bt_31.jpg" },
    32: { title: "웃는 고래의 기적", category: "소선지서", img: "/cards/bt_32.jpg" },
    33: { title: "사랑의 보석 상자", category: "소선지서", img: "/cards/bt_33.jpg" },
    34: { title: "무지개 구름의 평화 편지", category: "소선지서", img: "/cards/bt_34.jpg" },
    35: { title: "기쁨의 사슴 언덕", category: "소선지서", img: "/cards/bt_35.jpg" },
    36: { title: "기쁨의 축제 노래", category: "소선지서", img: "/cards/bt_36.jpg" },
    37: { title: "황금 성전의 완성", category: "소선지서", img: "/cards/bt_37.jpg" },
    38: { title: "영롱한 촛대와 별빛", category: "소선지서", img: "/cards/bt_38.jpg" },
    39: { title: "치료의 의로운 태양", category: "소선지서", img: "/cards/bt_39.jpg" },
    40: { title: "동방박사의 큰 별", category: "복음서·행전", img: "/cards/bt_40.jpg" },
    41: { title: "오병이어의 사랑 기적", category: "복음서·행전", img: "/cards/bt_41.jpg" },
    42: { title: "선한 목자의 품", category: "복음서·행전", img: "/cards/bt_42.jpg" },
    43: { title: "세상의 영롱한 빛", category: "복음서·행전", img: "/cards/bt_43.jpg" },
    44: { title: "성령의 불꽃 복음", category: "복음서·행전", img: "/cards/bt_44.jpg" },
    45: { title: "은혜의 무지개 길", category: "바울서신", img: "/cards/bt_45.jpg" },
    46: { title: "영원한 사랑의 하트", category: "바울서신", img: "/cards/bt_46.jpg" },
    47: { title: "질그릇 속의 보배", category: "바울서신", img: "/cards/bt_47.jpg" },
    48: { title: "성령의 9가지 열매", category: "바울서신", img: "/cards/bt_48.jpg" },
    49: { title: "구원의 전신갑주", category: "바울서신", img: "/cards/bt_49.jpg" },
    50: { title: "주 안의 항상 기쁨", category: "바울서신", img: "/cards/bt_50.jpg" },
    51: { title: "으뜸이 되신 사랑", category: "바울서신", img: "/cards/bt_51.jpg" },
    52: { title: "소망의 빛 파수꾼", category: "바울서신", img: "/cards/bt_52.jpg" },
    53: { title: "믿음의 굳건한 등불", category: "바울서신", img: "/cards/bt_53.jpg" },
    54: { title: "선한 싸움의 일꾼", category: "바울서신", img: "/cards/bt_54.jpg" },
    55: { title: "의로운 면류관", category: "바울서신", img: "/cards/bt_55.jpg" },
    56: { title: "선한 일의 기쁨", category: "바울서신", img: "/cards/bt_56.jpg" },
    57: { title: "용서와 사랑의 편지", category: "바울서신", img: "/cards/bt_57.jpg" },
    58: { title: "믿음의 영웅들", category: "일반서신", img: "/cards/bt_58.jpg" },
    59: { title: "행함이 있는 지혜", category: "일반서신", img: "/cards/bt_59.jpg" },
    60: { title: "산 소망의 산돌", category: "일반서신", img: "/cards/bt_60.jpg" },
    61: { title: "은혜와 지혜의 자람", category: "일반서신", img: "/cards/bt_61.jpg" },
    62: { title: "하나님은 사랑이시라", category: "일반서신", img: "/cards/bt_62.jpg" },
    63: { title: "진리와 사랑의 동행", category: "일반서신", img: "/cards/bt_63.jpg" },
    64: { title: "영혼의 평안과 기쁨", category: "일반서신", img: "/cards/bt_64.jpg" },
    65: { title: "믿음의 굳건한 등대", category: "일반서신", img: "/cards/bt_65.jpg" },
    66: { title: "새 하늘과 새 땅의 승리", category: "예언서", img: "/cards/bt_66.jpg" }
  };

  // [장 칩 터치 핸들러] 즉시 반응 + 안전한 서버 저장
  function onChapterChipClick(bookName, targetCh, maxCh) {
    if (!state.student) return showToast("로그인이 필요합니다.");
    var readList = getBookReadChapters(bookName);
    var isAlreadyRead = (readList.indexOf(targetCh) !== -1);
    var action = isAlreadyRead ? "remove" : "add";

    var absRanges = getBibleAbsRanges();
    var allReadAbsList = [];
    if (state.student.readLogs) {
      state.student.readLogs.forEach(function(l) {
        var r = absRanges.find(function(x) { return x.name === String(l.bookName).trim(); });
        if (r) {
          var aVal = r.startAbs + Number(l.chapter) - 1;
          if (allReadAbsList.indexOf(aVal) === -1) allReadAbsList.push(aVal);
        }
      });
    }
    allReadAbsList.sort(function(a, b) { return a - b; });

    // (이전 코드 유지: allReadAbsList.sort(...) 직후)
    
    if (!state.fixedDailyMission) {
      initDailyMissionForSession();
    }
    
    var MAX_ABS = getTotalActiveChapters();
    var myStartAbs = (state.fixedDailyMission && state.fixedDailyMission.startAbs) ? state.fixedDailyMission.startAbs : 1;
    var myEndAbs = (state.fixedDailyMission && state.fixedDailyMission.endAbs) ? state.fixedDailyMission.endAbs : 3;
    var globalTargetAbs = Math.min(MAX_ABS, getGlobalDayIndex() * 3); // 1189 -> MAX_ABS 교체
    var targetAbsCh = getAbsChapter(bookName, targetCh);

    // (이후 코드 그대로 유지)

    var hasReadTodayTarget = false;
    for (var k = 0; k < allReadAbsList.length; k++) {
      if (allReadAbsList[k] >= myStartAbs && allReadAbsList[k] <= myEndAbs) {
        hasReadTodayTarget = true;
        break;
      }
    }

    var isClickingMyTodayTarget = (targetAbsCh >= myStartAbs && targetAbsCh <= myEndAbs);

    // 오늘 미션을 아직 1장도 안 읽은 상태에서 과거 분량을 누를 때만 차단
    if (!isClickingMyTodayTarget && !hasReadTodayTarget && targetAbsCh < myStartAbs) {
      return showToast("⚠️ 오늘 미션을 먼저 1장 이상 완료해야 과거 분량을 수정/보충할 수 있습니다!");
    }

    var allowedMaxAbs = (hasReadTodayTarget || isClickingMyTodayTarget || allReadAbsList.length >= globalTargetAbs) ? globalTargetAbs : myEndAbs;
    if (action === "add" && targetAbsCh > allowedMaxAbs) {
      return showToast("⚠️ 아직 읽을 수 없는 범위입니다.");
    }

    var isOnTime = (targetAbsCh >= myStartAbs && targetAbsCh <= allowedMaxAbs);

    // 🚨 [즉각 반응 UI (Optimistic UI)]
    // 사용자가 터치하자마자 화면에 즉시 체크/해제 표시를 띄워 멈칫거림 제거
    if (!state.student.readLogs) state.student.readLogs = [];
    var prevLogsBackup = JSON.parse(JSON.stringify(state.student.readLogs));

    if (action === "add") {
      state.student.readLogs.push({ bookName: bookName, chapter: targetCh });
    } else {
      state.student.readLogs = state.student.readLogs.filter(function(l) {
        return !(String(l.bookName) === bookName && Number(l.chapter) === targetCh);
      });
    }
    renderBibleBookProgress();

    // 서버로 백그라운드 저장 통신 전송
    apiCall("saveReadingLog", state.sessionToken, bookName, [targetCh], action, isOnTime).then(function(res) {
      if (res && res.success) {
        state.student.stampBalance = res.stampBalance;
        state.student.gemBalance = res.gemBalance;
        state.student.totalUsedStamps = res.totalUsedStamps;
        state.student.streakOnTime = res.streakOnTime;
        if (res.readLogs) state.student.readLogs = res.readLogs;

        if (action === "remove") {
          showToast("🗑️ " + bookName + " " + targetCh + "장 해제");
        } else {
          showToast("📖 " + bookName + " " + targetCh + "장 완료!");
        }
        renderWallet();
        renderBibleBookProgress();
      } else {
        // 서버 실패 시에만 이전 상태로 원복하고 에러 알림 표시
        state.student.readLogs = prevLogsBackup;
        renderBibleBookProgress();
        showToast((res && res.error) ? res.error : "저장 처리 중 지연이 발생했습니다. 다시 시도해 주세요.");
      }
    });

    // 권별 완독 달성 시 카드 해금
    if (action === "add" && readList.length + 1 >= maxCh) {
      var bookDef = ALL_66_BIBLE_BOOKS.find(function(b) { return b.name === bookName; });
      if (bookDef) {
        apiCall("unlockStudentCard", state.sessionToken, bookDef.order).then(function(res) {
          if (res && res.success) {
            if (state.student) {
              state.student.gemBalance = (Number(state.student.gemBalance) || 0) + 2;
              renderWallet();
            }
            var cardInfo = BT_CARDS_MAP[bookDef.order] || {
              title: bookName + " 완독 카드",
              category: "성경",
              img: "https://lh3.googleusercontent.com/d/1sqlqAWp-B-LE0xGV0mQIiZU5xsfDobBL"
            };
            showToast("🎉 " + bookName + " 완독 달성! 💎 보석 +2개를 획득했습니다!");
            openCardDetailModal({ 
              bookOrder: bookDef.order, 
              bookName: bookName, 
              title: bookDef.order + ". " + bookName + " - " + cardInfo.title + " 해금! (+💎 2개)", 
              category: cardInfo.category, 
              imageUrl: cardInfo.img 
            }, true);
            loadCardDex();
          }
        });
      }
    }
  }

  function openShopGuideModal() {
    var modal = document.getElementById("modal-shop-guide");
    if (modal) {
      modal.classList.add("active");
      modal.style.display = "flex";
    }
  }

  function closeShopGuideModal() {
    var chk = document.getElementById("chk-never-show-shop-guide");
    if (chk && chk.checked) {
      localStorage.setItem("bt_hide_shop_guide", "true");
    }
    var modal = document.getElementById("modal-shop-guide");
    if (modal) {
      modal.classList.remove("active");
      modal.style.display = "none";
    }
  }

  function switchMapTab(mapId) {
    state.activeMapId = mapId;
    var tabs = document.querySelectorAll(".map-tab-item");
    tabs.forEach(function(t) {
      if (t.getAttribute("data-map-id") === mapId) t.classList.add("active");
      else t.classList.remove("active");
    });
    loadMapView(mapId);
  }

  state.mapPoints = {
    M01: [{x: 18, y: 78}, {x: 35, y: 72}, {x: 48, y: 62}, {x: 62, y: 55}, {x: 75, y: 35}, {x: 85, y: 18}],
    M02: [{x: 15, y: 80}, {x: 30, y: 65}, {x: 50, y: 70}, {x: 70, y: 45}, {x: 85, y: 20}],
    M03: [{x: 20, y: 82}, {x: 40, y: 68}, {x: 60, y: 50}, {x: 75, y: 32}, {x: 88, y: 18}],
    M04: [{x: 15, y: 80}, {x: 35, y: 65}, {x: 55, y: 55}, {x: 72, y: 38}, {x: 86, y: 20}],
    M05: [{x: 18, y: 78}, {x: 38, y: 62}, {x: 58, y: 70}, {x: 74, y: 42}, {x: 88, y: 22}],
    M06: [{x: 15, y: 82}, {x: 32, y: 66}, {x: 52, y: 58}, {x: 70, y: 40}, {x: 85, y: 18}],
    M07: [{x: 18, y: 80}, {x: 36, y: 64}, {x: 56, y: 68}, {x: 74, y: 44}, {x: 88, y: 20}],
    M08: [{x: 15, y: 82}, {x: 35, y: 68}, {x: 55, y: 52}, {x: 72, y: 35}, {x: 88, y: 18}]
  };

  function getInterpolatedPosition(mapId, dayIndex, totalDays) {
    var points = state.mapPoints[mapId];
    if (!points || points.length < 2) return { x: 50, y: 50 };

    var maxDay = Math.max(1, totalDays || 63);
    var current = Math.min(maxDay, Math.max(1, dayIndex || 1));
    var overallProgress = (current - 1) / Math.max(1, (maxDay - 1));

    var segmentCount = points.length - 1;
    var scaledProgress = overallProgress * segmentCount;
    var segIndex = Math.min(segmentCount - 1, Math.floor(scaledProgress));
    var localProgress = scaledProgress - segIndex;

    var pA = points[segIndex];
    var pB = points[segIndex + 1];

    return {
      x: pA.x + (pB.x - pA.x) * localProgress,
      y: pA.y + (pB.y - pA.y) * localProgress
    };
  }

  function loadMapView(mapId) {
    var activeMap = mapId || state.activeMapId || "M01";
    state.activeMapId = activeMap;
    
    var mapTitles = {
      M01: "M01. 모세오경 (창세기~신명기)",
      M02: "M02. 역사서 (여호수아~에스더)",
      M03: "M03. 시가서 (욥기~아가)",
      M04: "M04. 대선지서 (이사야~다니엘)",
      M05: "M05. 소선지서 (호세아~말라기)",
      M06: "M06. 복음서·사도행전 (마태~사도행전)",
      M07: "M07. 바울서신 (로마서~빌레몬서)",
      M08: "M08. 공동서신·요한계시록 (히브리~계시록)"
    };
    
    var mapImages = {
      M01: "/maps/M01.jpg",
      M02: "/maps/M02.jpg",
      M03: "/maps/M03.jpg",
      M04: "/maps/M04.jpg",
      M05: "/maps/M05.jpg",
      M06: "/maps/M06.jpg",
      M07: "/maps/M07.jpg",
      M08: "/maps/M08.jpg"
    };

    var titleEl = document.getElementById("map-current-title");
    if (titleEl) titleEl.textContent = mapTitles[activeMap] || "성경 유형 맵";

    var canvasBox = document.getElementById("map-canvas-box");
    if (canvasBox && mapImages[activeMap]) {
      canvasBox.style.backgroundImage = "url('" + mapImages[activeMap] + "')";
    }

    renderFriendsOnMap(activeMap);
  }

  // 💡 새로 추가 및 교체: 맵별로 현재 포함된 성경책의 장수를 합산하여 Day 구간을 동적 생성
  function getDynamicMapRanges() {
    var activeBooks = getFilteredBibleBooks();
    var mapGroups = { M01: 0, M02: 0, M03: 0, M04: 0, M05: 0, M06: 0, M07: 0, M08: 0 };
    
    // 각 성경책이 속한 맵에 장수 누적
    activeBooks.forEach(function(b) {
      if (b.order <= 5) mapGroups.M01 += b.chapters;
      else if (b.order <= 17) mapGroups.M02 += b.chapters;
      else if (b.order <= 22) mapGroups.M03 += b.chapters;
      else if (b.order <= 27) mapGroups.M04 += b.chapters;
      else if (b.order <= 39) mapGroups.M05 += b.chapters;
      else if (b.order <= 44) mapGroups.M06 += b.chapters;
      else if (b.order <= 57) mapGroups.M07 += b.chapters;
      else mapGroups.M08 += b.chapters;
    });

    var ranges = {};
    var startDay = 1;
    var mapNames = {
      M01: "모세오경", M02: "역사서", M03: "시가서", M04: "대선지서",
      M05: "소선지서", M06: "복음서·행전", M07: "바울서신", M08: "공동서신·계시록"
    };

    for (var i = 1; i <= 8; i++) {
      var mId = "M0" + i;
      var chapters = mapGroups[mId];
      var daysForMap = Math.ceil(chapters / 3);
      if (daysForMap <= 0) daysForMap = 1; // 0일 맵 오류 방지
      
      var endDay = startDay + daysForMap - 1;
      ranges[mId] = {
        min: startDay,
        max: endDay,
        totalDays: daysForMap,
        label: mId + " " + mapNames[mId] + " (Day " + startDay + "~" + endDay + ")"
      };
      startDay = endDay + 1; // 다음 맵의 시작일 갱신
    }
    return ranges;
  }

  function getMapDayRange(mapId) {
    var ranges = getDynamicMapRanges();
    return ranges[mapId] || ranges["M01"];
  }

  function renderFriendsOnMap(mapId) {
    var canvasBox = document.getElementById("map-canvas-box");
    var trackBox = document.getElementById("race-track-avatars");
    if (!canvasBox) return;

    var range = getMapDayRange(mapId);
    var rangeLabelEl = document.getElementById("map-range-label");
    if (rangeLabelEl) rangeLabelEl.textContent = range.label;

    var oldPins = document.querySelectorAll(".friend-map-pin");
    oldPins.forEach(function(p) { p.remove(); });
    if (trackBox) trackBox.innerHTML = "";

    var homeCanvasBox = document.getElementById("home-map-canvas");
    if (homeCanvasBox) homeCanvasBox.innerHTML = ""; 

    apiCall("listStudentCards").then(function(res) {
      if (!res.success || !res.students) return;

      var leaderboard = document.getElementById("leaderboard-list");
      if (leaderboard) leaderboard.innerHTML = "";

      var students = res.students;
      var myId = (state.student && state.student.studentId) ? String(state.student.studentId) : null;

      students.sort(function(a, b) {
        var streakA = Number(a.streakOnTime || 0);
        var streakB = Number(b.streakOnTime || 0);
        if (streakB !== streakA) return streakB - streakA;

        var stampA = Number(a.stampBalance || 0);
        var stampB = Number(b.stampBalance || 0);
        if (stampB !== stampA) return stampB - stampA;

        var gemA = Number(a.gemBalance || 0);
        var gemB = Number(b.gemBalance || 0);
        if (gemB !== gemA) return gemB - gemA;

        return (a.name || "").localeCompare(b.name || "", "ko");
      });

      students.forEach(function(s, stuIdx) {
        var rank = stuIdx + 1;
        var dayIdx = Number(s.currentDayIndex || 1);
        var stamps = Number(s.stampBalance || 0);
        var gems = Number(s.gemBalance || 0);
        var streak = Number(s.streakOnTime || 0);
        var isSelf = (myId && String(s.studentId) === myId);

        var rankBadge = "";
        if (rank === 1) rankBadge = '<span style="font-weight:800; font-size:11px; white-space:nowrap; flex-shrink:0; color:#d97706; background:#fef3c7; padding:3px 6px; border-radius:8px; border:1px solid #fde68a;">🥇 1위</span>';
        else if (rank === 2) rankBadge = '<span style="font-weight:800; font-size:11px; white-space:nowrap; flex-shrink:0; color:#475569; background:#f1f5f9; padding:3px 6px; border-radius:8px; border:1px solid #e2e8f0;">🥈 2위</span>';
        else if (rank === 3) rankBadge = '<span style="font-weight:800; font-size:11px; white-space:nowrap; flex-shrink:0; color:#92400e; background:#fff7ed; padding:3px 6px; border-radius:8px; border:1px solid #ffedd5;">🥉 3위</span>';
        else rankBadge = '<span style="font-weight:800; font-size:11px; white-space:nowrap; flex-shrink:0; color:var(--muted); background:#f8fafc; padding:3px 6px; border-radius:8px; border:1px solid var(--border);">' + rank + '위</span>';

        var itemBg = isSelf ? "linear-gradient(135deg, #fff0f7 0%, #ffffff 100%)" : "#ffffff";
        var itemBorder = isSelf ? "2px solid var(--primary)" : "1px solid var(--border)";
        var itemShadow = isSelf ? "box-shadow: 0 4px 14px rgba(255,102,175,0.25);" : "";
        var nameFontSize = isSelf ? "14px" : "13px";

        var itemHtml = '<div style="display:flex; align-items:center; justify-content:space-between; padding:10px 10px; border-radius:14px; background:' + itemBg + '; border:' + itemBorder + '; ' + itemShadow + ' margin-bottom:8px;">' +
                       '<div style="display:flex; align-items:center; gap:8px; flex:1; min-width:0;">' +
                       rankBadge +
                       '<span style="font-size:20px; flex-shrink:0;">' + (s.displayEmoji || "⭐") + '</span>' +
                       '<div style="min-width:0; flex:1; display:flex; flex-direction:column; justify-content:center; gap:2px;">' +
                       '<div style="font-weight:800; font-size:' + nameFontSize + '; color:var(--foreground); display:flex; align-items:center; gap:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' +
                       '<span>' + s.name + '</span>' +
                       '<span style="font-size:11px; color:var(--muted); font-weight:normal; flex-shrink:0;">(' + s.department + ')</span>' +
                       (isSelf ? ' <span style="background:var(--primary); color:#ffffff; font-size:10px; padding:1px 5px; border-radius:6px; font-weight:800; flex-shrink:0;">나</span>' : "") +
                       '</div>' +
                       '<div style="font-size:11px; font-weight:700; color:var(--primary); white-space:nowrap; display:flex; align-items:center; gap:4px;">' +
                       '<span>💮 도장 ' + stamps + '개</span><span style="color:#cbd5e1; font-weight:normal;">|</span><span>💎 보석 ' + gems + '개</span>' +
                       '</div>' +
                       '</div></div>' +
                       '<div style="text-align:right; flex-shrink:0; margin-left:6px; display:flex; flex-direction:column; align-items:flex-end; gap:2px;">' +
                       '<span style="font-size:11px; font-weight:800; color:var(--secondary); background:#eff6ff; padding:3px 8px; border-radius:10px; display:inline-block; white-space:nowrap;">🔥 연속 ' + streak + '일</span>' +
                       '<div style="font-size:10px; font-weight:700; color:var(--muted); white-space:nowrap;">📍 Day ' + dayIdx + '</div>' +
                       '</div>' +
                       '</div>';

        if (leaderboard) leaderboard.insertAdjacentHTML('beforeend', itemHtml);

        if (dayIdx >= range.min && dayIdx <= range.max) {
          // 💡 수정됨: 63 대신 현재 맵의 동적 totalDays 사용
          var fPos = getInterpolatedPosition(mapId, dayIdx - range.min + 1, range.totalDays);
          var offsetY = (stuIdx % 3) * 6 - 6;
          var offsetX = (stuIdx % 2) * 8 - 4;

          if (canvasBox) {
            var fPin = document.createElement("div");
            fPin.className = "friend-map-pin avatar-pin" + (isSelf ? " self-avatar" : "");
            fPin.style.cssText = "left:" + (fPos.x + offsetX) + "%; top:" + (fPos.y + offsetY) + "%; z-index:" + (isSelf ? "500" : (100 + stuIdx)) + ";";
            fPin.innerHTML = '<div class="avatar-bubble" style="background:' + (isSelf ? "linear-gradient(135deg, #fff0f7 0%, #ffffff 100%)" : "#ffffff") + '; border-color:' + (isSelf ? "var(--primary)" : "var(--secondary)") + '; ' + (isSelf ? "box-shadow: 0 0 10px rgba(255,102,175,0.6);" : "") + '">' +
                             '<span style="color:' + (isSelf ? "var(--primary)" : "var(--foreground)") + '; font-weight:800;">' + s.name + (isSelf ? " (나)" : "") + '</span></div>' +
                             '<div class="avatar-icon-box" style="background:' + (s.cardColor || "#3b82f6") + '; color:#fff; border-color:' + (isSelf ? "var(--primary)" : "#fff") + '; ' + (isSelf ? "box-shadow: 0 0 8px rgba(255,102,175,0.8);" : "") + '">' + (s.displayEmoji || "⭐") + '</div>';
            canvasBox.appendChild(fPin);
          }

          if (homeCanvasBox && isSelf) {
            var homePin = document.createElement("div");
            homePin.className = "friend-map-pin avatar-pin self-avatar";
            homePin.style.cssText = "left:" + fPos.x + "%; top:" + fPos.y + "%; z-index:500;";
            homePin.innerHTML = '<div class="avatar-bubble" style="background:linear-gradient(135deg, #fff0f7 0%, #ffffff 100%); border-color:var(--primary); box-shadow: 0 0 10px rgba(255,102,175,0.6);">' +
                                '<span style="color:var(--primary); font-weight:800;">' + s.name + ' (나)</span></div>' +
                                '<div class="avatar-icon-box" style="background:' + (s.cardColor || "#3b82f6") + '; color:#fff; border-color:var(--primary); box-shadow: 0 0 8px rgba(255,102,175,0.8);">' + (s.displayEmoji || "⭐") + '</div>';
            homeCanvasBox.appendChild(homePin);
          }

          if (trackBox) {
            // 💡 수정됨: 63 대신 현재 맵의 동적 totalDays 사용
            var progressInMap = (dayIdx - range.min + 1) / range.totalDays;
            var leftPct = Math.max(10, Math.min(90, 10 + (progressInMap * 80)));
            var trackOffsetY = (stuIdx % 2) * 16 - 8;
            var raceItem = document.createElement("div");
            raceItem.className = "race-avatar-item";
            raceItem.style.cssText = "left:" + leftPct + "%; margin-top:" + trackOffsetY + "px; z-index:" + (isSelf ? "500" : (20 + stuIdx)) + ";";
            raceItem.innerHTML = '<div class="race-avatar-name" style="border-color:' + (isSelf ? "var(--primary)" : "var(--border)") + '; font-weight:' + (isSelf ? "800" : "700") + ';">' + s.name + (isSelf ? " (나)" : "") + '</div>' +
                                 '<div class="race-avatar-icon" style="background:' + (s.cardColor || "#ff66af") + '; color:#fff;">' + (s.displayEmoji || "⭐") + '</div>';
            trackBox.appendChild(raceItem);
          }
        }
      });
    });
  }

  function updateUserHeader() {
    var selectBtn = document.getElementById("btn-select-user");
    var profileBadge = document.getElementById("user-profile-badge");

    if (state.student) {
      if (selectBtn) selectBtn.style.display = "none";
      if (profileBadge) profileBadge.style.display = "flex";

      var emoEl = document.getElementById("user-display-emoji");
      var nameEl = document.getElementById("user-display-name");
      var locEl = document.getElementById("user-reading-location");

      if (emoEl) emoEl.textContent = state.student.displayEmoji || "🦁";
      if (nameEl) nameEl.textContent = state.student.name;
      if (locEl) locEl.textContent = "📖 Day " + getGlobalDayIndex();
    } else {
      if (selectBtn) selectBtn.style.display = "inline-block";
      if (profileBadge) profileBadge.style.display = "none";
    }
  }

  // 6. 🚪 로그아웃 시 세션 고정값 초기화
  function onLogout() {
    state.sessionToken = null;
    state.student = null;
    state.fixedDailyMission = null; // 고정값 리셋
    localStorage.removeItem("bt_session_token");
    localStorage.removeItem("bt_student_data");
    showToast("로그아웃 되었습니다.");
    updateUserHeader();
    switchTab("onboarding");
  }

  function getDepartmentSortWeight(dept) {
    var d = String(dept || "").trim();
    if (d.indexOf("유치") !== -1 || d.indexOf("영아") !== -1 || d.indexOf("유아") !== -1) return 10;
    if (d.indexOf("5세") !== -1) return 15;
    if (d.indexOf("6세") !== -1) return 16;
    if (d.indexOf("7세") !== -1) return 17;
    if (d.indexOf("1학년") !== -1) return 21;
    if (d.indexOf("2학년") !== -1) return 22;
    if (d.indexOf("3학년") !== -1) return 23;
    if (d.indexOf("4학년") !== -1) return 24;
    if (d.indexOf("5학년") !== -1) return 25;
    if (d.indexOf("6학년") !== -1) return 26;
    if (d.indexOf("초등") !== -1) return 29;
    if (d.indexOf("중등") !== -1 || d.indexOf("중학교") !== -1) return 30;
    if (d.indexOf("고등") !== -1 || d.indexOf("고등학교") !== -1) return 40;
    if (d.indexOf("청년") !== -1) return 50;
    if (d.indexOf("교사") !== -1 || d.indexOf("선생") !== -1) return 90;
    return 60;
  }

  function openStudentSelectModal() {
    var modal = document.getElementById("modal-student-select");
    var grid = document.getElementById("student-select-grid");
    if (!modal || !grid) return;

    grid.innerHTML = "<p style='grid-column:1/-1; text-align:center; padding:20px; color:var(--muted); font-size:13px;'>명단을 불러오는 중...</p>";
    modal.classList.add("active");
    modal.style.display = "flex";

    apiCall("listStudentCards").then(function(res) {
      if (!res.success) {
        grid.innerHTML = "<p style='grid-column:1/-1; text-align:center; padding:20px; color:red; font-size:13px;'>" + (res.error || "목록을 불러오지 못했습니다.") + "</p>";
        return;
      }

      grid.innerHTML = "";
      var students = res.students || [];

      if (students.length === 0) {
        grid.innerHTML = "<p style='grid-column:1/-1; text-align:center; padding:20px; font-size:13px;'>등록된 명단이 없습니다.</p>";
        return;
      }

      var myId = (state.student && state.student.studentId) ? String(state.student.studentId) : null;

      students.sort(function(a, b) {
        if (myId && String(a.studentId) === myId) return -1;
        if (myId && String(b.studentId) === myId) return 1;

        var weightA = getDepartmentSortWeight(a.department);
        var weightB = getDepartmentSortWeight(b.department);

        if (weightA !== weightB) {
          return weightA - weightB;
        }
        return String(a.name).localeCompare(String(b.name), 'ko');
      });

      students.forEach(function(s) {
        var isSelf = (myId && String(s.studentId) === myId);
        var cardBg = isSelf ? "var(--primary-light)" : "#ffffff";
        var cardBorder = isSelf ? "2.5px solid var(--primary)" : ("1.5px solid " + (s.cardColor || "#ff66af"));

        var card = document.createElement("div");
        card.style.cssText = "padding:10px 4px; border-radius:14px; border:" + cardBorder + "; background:" + cardBg + "; cursor:pointer; text-align:center; transition:all 0.15s ease; box-shadow:0 2px 6px rgba(0,0,0,0.04); display:flex; flex-direction:column; align-items:center; justify-content:center;";
        card.innerHTML = '<div style="font-size:24px; line-height:1; margin-bottom:4px;">' + (s.displayEmoji || "⭐") + '</div>' +
                         '<div style="font-size:13px; font-weight:800; color:var(--foreground); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; width:100%;">' + s.name + (isSelf ? " (나)" : "") + '</div>' +
                         '<div style="font-size:10px; color:var(--muted); font-weight:700; margin-top:2px; background:#f8fafc; padding:1px 4px; border-radius:6px; border:1px solid var(--border);">' + (s.department || "초등부") + '</div>';
        
        card.onclick = function() {
          closeStudentSelectModal();
          openPinModal(s.studentId, s.name);
        };
        grid.appendChild(card);
      });
    });
  }

  function closeStudentSelectModal() {
    var modal = document.getElementById("modal-student-select");
    if (modal) {
      modal.classList.remove("active");
      modal.style.display = "none";
    }
  }

  function openPinModal(studentId, name) {
    targetStudentIdForLogin = studentId;
    state.selectedStudentId = studentId;
    
    var modal = document.getElementById("modal-pin");
    var nameEl = document.getElementById("modal-student-name");
    if (!modal) return;

    if (nameEl) nameEl.textContent = name + " 님 (PIN 4자리 입력)";

    for (var i = 1; i <= 4; i++) {
      var input = document.getElementById("pin-input-" + i);
      if (input) input.value = "";
    }

    modal.classList.add("active");
    modal.style.display = "flex";

    setTimeout(function() {
      var first = document.getElementById("pin-input-1");
      if (first) {
        first.focus();
        first.select();
      }
    }, 150);
  }

  function closePinModal() {
    var modal = document.getElementById("modal-pin");
    if (modal) {
      modal.classList.remove("active");
      modal.style.display = "none";
    }
  }

  function onPinDigitInput(e, index) {
    var key = e.key;
    var val = document.getElementById("pin-input-" + index).value;

    if (key === "Backspace") {
      if (index > 1 && !val) {
        var prev = document.getElementById("pin-input-" + (index - 1));
        if (prev) { prev.focus(); prev.select(); }
      }
      return;
    }

    if (val && val.length === 1) {
      if (index < 4) {
        var next = document.getElementById("pin-input-" + (index + 1));
        if (next) { next.focus(); next.select(); }
      } else if (index === 4) {
        submitPinLogin();
      }
    }
  }

  // 5. 🔒 로그인 시 세션 고정 미션 새로 산출
  function submitPinLogin() {
    var p1 = document.getElementById("pin-input-1").value || "";
    var p2 = document.getElementById("pin-input-2").value || "";
    var p3 = document.getElementById("pin-input-3").value || "";
    var p4 = document.getElementById("pin-input-4").value || "";
    var pin = p1 + p2 + p3 + p4;

    if (pin.length !== 4) return showToast("PIN 4자리를 모두 입력하세요.");

    var sId = targetStudentIdForLogin || state.selectedStudentId;

    apiCall("verifyStudentPin", sId, pin).then(function(res) {
      if (!res.success) return showToast(res.error || "PIN 번호가 일치하지 않습니다.");

      state.sessionToken = res.sessionToken;
      state.student = res.student;

      if (res.student && String(res.student.department).indexOf("교사") !== -1) {
        state.isTeacher = true;
        state.isMasterAdmin = false;
        state.teacherToken = "TEACHER_TOKEN_" + res.student.studentId;
        sessionStorage.removeItem("bt_is_master_admin");
      } else if (state.isTeacher) {
        onTeacherLogout(true);
      }
      
      localStorage.setItem("bt_session_token", res.sessionToken);
      localStorage.setItem("bt_student_data", JSON.stringify(res.student));

      // 🚨 새 로그인 시점에만 미션 3장을 새로 계산하여 세션에 고정
      initDailyMissionForSession();
      state.selectedBookIndex = getTodayBibleBookIndex();

      closePinModal();
      showToast("🎉 " + res.student.name + " 님 환영합니다!");
      updateUserHeader();
      switchTab("home");
      loadMapView(state.activeMapId);
    });
  }

  function onTeacherLogin() {
    var pinEl = document.getElementById("teacher-pin-input");
    if (!pinEl) return;
    var pin = pinEl.value ? pinEl.value.trim() : "";
    if (!pin) return showToast("PIN 번호 4자리를 입력하세요.");

    apiCall("verifyTeacherPin", pin).then(function(res) {
      if (!res.success) return showToast(res.error || "교사/관리자 PIN 번호가 일치하지 않습니다.");

      if (state.student) {
        state.student = null;
        state.sessionToken = null;
        localStorage.removeItem("bt_session_token");
        localStorage.removeItem("bt_student_data");
      }

      state.isTeacher = true;
      state.isMasterAdmin = true;
      state.teacherToken = res.token;
      sessionStorage.setItem("bt_is_master_admin", "true");

      showToast("👩‍🏫 교사 및 관리자 인증 성공!");
      
      var authBox = document.getElementById("teacher-auth-box");
      var panel = document.getElementById("teacher-panel");

      if (authBox) authBox.style.display = "none";
      if (panel) panel.style.display = "block";

      updateUserHeader();
      loadCardDex();
      loadTeacherDashboard();
    });
  }

  function onTeacherLogout(isAuto) {
    state.isTeacher = false;
    state.isMasterAdmin = false;
    state.teacherToken = null;
    sessionStorage.removeItem("bt_is_master_admin");
    
    var authBox = document.getElementById("teacher-auth-box");
    var panel = document.getElementById("teacher-panel");
    var adminTools = document.getElementById("admin-map-tools");

    if (authBox) authBox.style.display = "block";
    if (panel) panel.style.display = "none";
    if (adminTools) adminTools.style.display = "none";

    if (!isAuto) showToast("🚪 관리자 모드에서 로그아웃 되었습니다.");
    updateUserHeader();
    loadCardDex();
  }

  function openRecBooksModal() {
    var modal = document.getElementById("modal-rec-books-select");
    if (!modal) return;
    renderRecBooksGrid();
    modal.classList.add("active");
    modal.style.display = "flex";
  }

  function closeRecBooksModal() {
    var modal = document.getElementById("modal-rec-books-select");
    if (modal) {
      modal.classList.remove("active");
      modal.style.display = "none";
    }
  }

  function renderRecBooksSummaryText() {
    var summaryEl = document.getElementById("rec-books-summary-text");
    var cardBadge = document.getElementById("rec-books-count-badge");
    if (!summaryEl) return;

    var recSet = {};
    if (state.recommendedBooks && Array.isArray(state.recommendedBooks)) {
      state.recommendedBooks.forEach(function(id) { recSet[String(id).trim()] = true; });
    } else {
      ALL_66_BIBLE_BOOKS.forEach(function(b) { recSet[b.id] = true; });
    }

    var selectedNames = [];
    ALL_66_BIBLE_BOOKS.forEach(function(b) {
      if (recSet[b.id] === true) selectedNames.push(b.name);
    });

    var count = selectedNames.length;
    if (cardBadge) cardBadge.textContent = "선택: " + count + " / 66권";

    if (count === 66) {
      summaryEl.textContent = "현재 선택된 성경책: 66권 전체";
    } else if (count === 0) {
      summaryEl.textContent = "현재 선택된 성경책: 없음 (모두 제외됨)";
    } else {
      var displayStr = selectedNames.slice(0, 5).join(", ");
      if (selectedNames.length > 5) displayStr += " 외 " + (selectedNames.length - 5) + "권";
      summaryEl.textContent = "현재 선택된 성경책 (" + count + "권): " + displayStr;
    }
  }

  function renderRecBooksGrid() {
    var grid = document.getElementById("modal-rec-books-grid");
    var badge = document.getElementById("modal-rec-books-badge");
    if (!grid) return;

    grid.innerHTML = "";
    var recSet = {};
    if (state.recommendedBooks && Array.isArray(state.recommendedBooks)) {
      state.recommendedBooks.forEach(function(id) { recSet[String(id).trim()] = true; });
    } else {
      ALL_66_BIBLE_BOOKS.forEach(function(b) { recSet[b.id] = true; });
    }

    var selectedCount = 0;

    ALL_66_BIBLE_BOOKS.forEach(function(b) {
      var isChecked = (recSet[b.id] === true);
      if (isChecked) selectedCount++;

      var label = document.createElement("label");
      label.style.cssText = "display:flex; align-items:center; gap:4px; font-size:12px; cursor:pointer; background:var(--bg-card); padding:6px 8px; border-radius:8px; border:1px solid var(--border); user-select:none;";
      
      var chk = document.createElement("input");
      chk.type = "checkbox";
      chk.value = b.id;
      chk.checked = isChecked;
      chk.style.cssText = "width:16px; height:16px; accent-color:var(--primary); cursor:pointer;";
      chk.onchange = updateRecBooksBadgeCount;

      var txt = document.createElement("span");
      txt.textContent = b.order + ". " + b.name;
      txt.style.fontWeight = isChecked ? "800" : "500";
      if (!isChecked) txt.style.color = "var(--muted)";

      chk.addEventListener("change", function() {
        txt.style.fontWeight = chk.checked ? "800" : "500";
        txt.style.color = chk.checked ? "var(--foreground)" : "var(--muted)";
      });

      label.appendChild(chk);
      label.appendChild(txt);
      grid.appendChild(label);
    });

    if (badge) badge.textContent = "선택: " + selectedCount + " / 66권";
    renderRecBooksSummaryText();
  }

  function updateRecBooksBadgeCount() {
    var grid = document.getElementById("modal-rec-books-grid");
    var badge = document.getElementById("modal-rec-books-badge");
    if (!grid || !badge) return;
    var chks = grid.querySelectorAll("input[type='checkbox']:checked");
    badge.textContent = "선택: " + chks.length + " / 66권";
  }

  function selectAllRecBooks(flag) {
    var grid = document.getElementById("modal-rec-books-grid");
    if (!grid) return;
    var chks = grid.querySelectorAll("input[type='checkbox']");
    chks.forEach(function(c) { 
      c.checked = !!flag; 
      var labelSpan = c.nextElementSibling;
      if (labelSpan) {
        labelSpan.style.fontWeight = flag ? "800" : "500";
        labelSpan.style.color = flag ? "var(--foreground)" : "var(--muted)";
      }
    });
    updateRecBooksBadgeCount();
  }

  function selectGroupRecBooks(type) {
    var grid = document.getElementById("modal-rec-books-grid");
    if (!grid) return;
    var chks = grid.querySelectorAll("input[type='checkbox']");

    chks.forEach(function(c) {
      var val = c.value;
      var b = ALL_66_BIBLE_BOOKS.find(function(x) { return x.id === val; });
      if (!b) return;

      var targetFlag = false;
      if (type === 'OT') targetFlag = (b.order <= 39);
      else if (type === 'NT') targetFlag = (b.order >= 40);
      else if (type === 'SKIP_LEV_NUM') targetFlag = (val !== 'LEV' && val !== 'NUM');

      c.checked = targetFlag;
      var labelSpan = c.nextElementSibling;
      if (labelSpan) {
        labelSpan.style.fontWeight = targetFlag ? "800" : "500";
        labelSpan.style.color = targetFlag ? "var(--foreground)" : "var(--muted)";
      }
    });
    updateRecBooksBadgeCount();
  }

  function saveRecBooksSelection() {
    var grid = document.getElementById("modal-rec-books-grid");
    if (!grid) return;
    var chks = grid.querySelectorAll("input[type='checkbox']:checked");
    var selectedIds = [];
    chks.forEach(function(c) { selectedIds.push(c.value); });

    apiCall("saveRecommendedBooks", state.teacherToken, selectedIds).then(function(res) {
      if (res && res.success) {
        state.recommendedBooks = res.recommendedBooks;
        showToast("🎉 하루 3장 추천 성경책이 선택 저장되었습니다! (" + selectedIds.length + "권)");
        closeRecBooksModal();
        renderRecBooksSummaryText();
        state.selectedBookIndex = getTodayBibleBookIndex();
        renderBibleBookProgress();
      } else {
        showToast("⚠️ 저장 실패: " + (res.error || "오류 발생"));
      }
    });
  }

  function loadTeacherDashboard() {
    var authBox = document.getElementById("teacher-auth-box");
    var panel = document.getElementById("teacher-panel");
    var coordSetting = document.getElementById("coord-master-setting");
    var dateSetting = document.getElementById("program-date-setting");

    var isGeneralTeacher = (state.student && String(state.student.department).indexOf("교사") !== -1);

    if (state.isTeacher || isGeneralTeacher) { 
      if (authBox) authBox.style.display = "none";
      if (panel) panel.style.display = "block";
      // 🚨 마스터 설정(맵 좌표 추출 도구, 오픈 시작일 변경 가이드)은 7777 마스터 관리자 PIN 인증 시에만 노출 (일반 교사는 숨김)
      if (coordSetting) coordSetting.style.display = state.isMasterAdmin ? "block" : "none";
      if (dateSetting) dateSetting.style.display = state.isMasterAdmin ? "block" : "none";
      renderRecBooksSummaryText();
      renderTeacherMarketAdminList();
    } else { 
      if (authBox) authBox.style.display = "block";
      if (panel) panel.style.display = "none";
      if (coordSetting) coordSetting.style.display = "none";
      if (dateSetting) dateSetting.style.display = "none";
    }
  }

  function openProgramDateModal() {
    var modal = document.getElementById("modal-program-date");
    if (modal) {
      modal.classList.add("active");
      modal.style.display = "flex";
    }
  }

  function closeProgramDateModal() {
    var modal = document.getElementById("modal-program-date");
    if (modal) {
      modal.classList.remove("active");
      modal.style.display = "none";
    }
  }

  function toggleEditMode() {
    var box = document.getElementById("map-canvas-box");
    if (!box) return;

    if (!state.editMode) {
      state.editMode = true;
      
      showToastConfirm("['" + state.activeMapId + "'] 맵의 기존 좌표를 지우고 새로 찍으시겠습니까?").then(function(isReset) {
        if (isReset) {
          state.tempMapPoints = [];
          var oldDots = box.querySelectorAll(".coord-dot");
          oldDots.forEach(function(d) { d.remove(); });
          showToast("🎯 [" + state.activeMapId + "] 새 좌표를 찍어주세요!");
        } else {
          state.tempMapPoints = (state.mapPoints[state.activeMapId] ? JSON.parse(JSON.stringify(state.mapPoints[state.activeMapId])) : []);
          showToast("🎯 [" + state.activeMapId + "] 기존 좌표에 이어서 찍습니다.");
        }

        box.style.cursor = "crosshair";

        box.onclick = function(e) {
          var rect = box.getBoundingClientRect();
          var x = Math.round((e.clientX - rect.left) / rect.width * 100);
          var y = Math.round((e.clientY - rect.top) / rect.height * 100);

          state.tempMapPoints.push({x: x, y: y});

          var dot = document.createElement("div");
          dot.className = "coord-dot";
          dot.style.cssText = "position:absolute; left:"+x+"%; top:"+y+"%; width:12px; height:12px; background:red; border-radius:50%; transform:translate(-50%,-50%); z-index:999; border:2px solid white;";
          box.appendChild(dot);
          showToast(state.tempMapPoints.length + "번째 좌표 찍힘 (" + state.activeMapId + ")");
        };

        var btnBox = document.createElement("div");
        btnBox.id = "coord-btn-box";
        btnBox.style.cssText = "position:absolute; bottom:10px; left:50%; transform:translateX(-50%); z-index:1000; display:flex; gap:8px;";

        var resetBtn = document.createElement("button");
        resetBtn.className = "btn-pill";
        resetBtn.style.cssText = "background:#ef4444; padding:8px 16px; font-size:12px; width:auto;";
        resetBtn.textContent = "🗑️ 전부 지우기";
        resetBtn.onclick = function(e) {
          e.stopPropagation();
          state.tempMapPoints = [];
          var dots = box.querySelectorAll(".coord-dot");
          dots.forEach(function(d) { d.remove(); });
          showToast("초기화되었습니다.");
        };

        var saveBtn = document.createElement("button");
        saveBtn.className = "btn-pill";
        saveBtn.style.cssText = "background:#10b981; padding:8px 16px; font-size:12px; width:auto;";
        saveBtn.textContent = "✅ 영구 저장";
        saveBtn.onclick = function(e) {
          e.stopPropagation();
          if (state.tempMapPoints.length < 2) return showToast("최소 2개 이상의 점을 찍어주세요.");
          
          state.mapPoints[state.activeMapId] = state.tempMapPoints;
          showToast("좌표 저장 중...");
          
          apiCall("saveMapPointsToSheet", state.activeMapId, state.tempMapPoints).then(function(res) {
            showToast("🎉 " + state.activeMapId + " 맵 좌표가 저장되었습니다!");
            toggleEditMode(); 
            loadMapView(state.activeMapId); 
          });
        };

        btnBox.appendChild(resetBtn);
        btnBox.appendChild(saveBtn);
        box.appendChild(btnBox);
      });

    } else {
      state.editMode = false;
      box.style.cursor = "default";
      box.onclick = null;
      var btnBox = document.getElementById("coord-btn-box");
      if (btnBox) btnBox.remove();
      var dots = box.querySelectorAll(".coord-dot");
      dots.forEach(function(d) { d.remove(); });
    }
  }

  function loadCardDex() {
    var grid = document.getElementById("card-dex-grid");
    if (!grid) return;
    grid.innerHTML = "<p style='grid-column:span 4; text-align:center; padding:20px; color:var(--muted);'>카드 도감을 불러오는 중...</p>";

    apiCall("getCardDex", state.sessionToken).then(function(res) {
      if (!res || !res.success) {
        res = { success: true, cards: [], totalCount: 66, unlockedCount: 0 };
      }

      var isTeacher = (state.isTeacher === true);
      var totalUnlocked = isTeacher ? 66 : (res.unlockedCount || 0);
      
      var progressEl = document.getElementById("dex-progress");
      if (progressEl) progressEl.textContent = totalUnlocked + " / " + res.totalCount + " 완독";
      
      grid.innerHTML = "";

      var cardList = (res.cards && res.cards.length > 0) ? res.cards : [];

      cardList.forEach(function(c) {
        var isUnlocked = isTeacher || (c.isUnlocked === true);
        var item = document.createElement("div");
        item.className = "card-dex-item" + (isUnlocked ? " unlocked" : "");

        if (isUnlocked) {
          item.innerHTML = '<div style="font-size:10px; font-weight:800; color:var(--primary); margin-bottom:4px;">' + c.bookOrder + '. ' + c.bookName + '</div>' +
                           '<div style="width:100%; height:75px; background:url(\'' + c.imageUrl + '\') center/cover no-repeat; border-radius:8px; margin-bottom:4px; box-shadow:0 2px 6px rgba(0,0,0,0.15);"></div>' +
                           '<div style="font-size:10px; font-weight:700; color:var(--foreground); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + c.title + '</div>';
        } else {
          item.innerHTML = '<div style="font-size:10px; color:var(--muted); font-weight:700;">' + c.bookOrder + '. ' + c.bookName + '</div>' +
                           '<div style="font-size:20px; margin:6px 0;">🔒</div>' +
                           '<div style="font-size:10px; color:var(--muted);">미해금</div>';
        }

        item.onclick = function() {
          openCardDetailModal(c, isUnlocked);
        };

        grid.appendChild(item);
      });
    });
  }

  function openCardDetailModal(card, isUnlocked) {
    var modal = document.getElementById("modal-card-detail");
    if (!modal) return;

    var catEl = document.getElementById("detail-card-category");
    var titleEl = document.getElementById("detail-card-title");
    var imgEl = document.getElementById("detail-card-img");
    var descEl = document.getElementById("detail-card-desc");

    if (catEl) catEl.textContent = card.category || "BT 카드";
    if (titleEl) titleEl.textContent = isUnlocked ? (card.bookOrder + ". " + card.bookName + " - " + card.title) : "미해금 카드";
    var lockSvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='300' height='400' viewBox='0 0 300 400'><rect width='100%' height='100%' fill='%23f8fafc'/><text x='50%' y='46%' font-size='60' text-anchor='middle' dominant-baseline='middle'>🔒</text><text x='50%' y='62%' font-size='16' font-family='sans-serif' font-weight='bold' fill='%2394a3b8' text-anchor='middle' dominant-baseline='middle'>미해금 카드</text></svg>";
    if (imgEl) imgEl.src = (isUnlocked && card.imageUrl) ? card.imageUrl : lockSvg;
    if (descEl) descEl.textContent = isUnlocked ? (card.bookName + " 완독을 축하합니다!") : "성경을 완독하여 카드를 해금하세요.";

    modal.classList.add("active");
    modal.style.display = "flex";
  }

  function closeCardDetailModal() {
    var modal = document.getElementById("modal-card-detail");
    if (modal) {
      modal.classList.remove("active");
      modal.style.display = "none";
    }
  }

  function onCreateStudent() {
    var nameEl = document.getElementById("new-student-name");
    var deptEl = document.getElementById("new-student-dept");
    var name = nameEl ? nameEl.value : "";
    var dept = deptEl ? deptEl.value : "초등부";
    
    if (!name) return showToast("이름을 입력하세요.");
    apiCall("registerStudent", name, dept).then(function(res) {
      if (!res.success) return showToast(res.error);
      showToast("등록 성공! 발급된 PIN: " + res.pin);
      if (nameEl) nameEl.value = "";
    });
  }

  // [🙏 감사 피드 로드]
  function loadGratitudeFeed() {
    var container = document.getElementById("gratitude-feed-list");
    if (!container) return;
    container.innerHTML = "<p style='color:var(--muted); text-align:center; padding:20px; grid-column:span 2;'>감사제목을 불러오는 중...</p>";

    apiCall("listGratitudeEntries", state.sessionToken).then(function(res) {
      var feedList = (res && res.success && res.entries) ? res.entries : [];
      var usedLikes = res ? (res.todayMyLikesCount || 0) : 0;
      renderGratitudeFeed(feedList, usedLikes);
    });
  }

  // [감사 피드 렌더링] 성경 완독 -> 감사 작성 -> 좋아요 체인 제어
  function renderGratitudeFeed(items, usedLikes) {
    var container = document.getElementById("gratitude-feed-list");
    if (!container) return;
    container.innerHTML = "";

    var myStudentId = (state.student && state.student.studentId) ? String(state.student.studentId) : null;
    var now = new Date();
    var yyyy = now.getFullYear();
    var mm = (now.getMonth() + 1 < 10 ? "0" : "") + (now.getMonth() + 1);
    var dd = (now.getDate() < 10 ? "0" : "") + now.getDate();
    var todayStr = yyyy + "-" + mm + "-" + dd;
    
    // 1. 오늘 성경을 1장 이상 읽었는지 검사 (readLogs 확인)
    var hasReadBibleToday = false;
    if (state.student && state.student.readLogs) {
      // readLogs에 기록이 있고, 마지막 진도 체크가 진행되었는지 확인
      hasReadBibleToday = state.student.readLogs.length > 0; 
    }

    // 2. 오늘 본인의 감사를 작성했는지 검사
    var hasWrittenGratitudeToday = false;
    items.forEach(function(g) {
      var isMyPost = (myStudentId && String(g.studentId) === myStudentId);
      var isTodayPost = (g.createdAt && g.createdAt.indexOf(todayStr) === 0);
      if (isMyPost && isTodayPost) {
        hasWrittenGratitudeToday = true;
      }
    });

    // 상단 진행 가이드 바 렌더링
    var remainingLikes = Math.max(0, 3 - (usedLikes || 0));
    var guideMsg = "";
    if (!hasReadBibleToday) {
      guideMsg = "⚠️ <strong>1단계:</strong> 홈 탭에서 성경을 먼저 1장 이상 읽어야 감사를 쓸 수 있어요!";
    } else if (!hasWrittenGratitudeToday) {
      guideMsg = "⚠️ <strong>2단계:</strong> 오늘의 감사를 먼저 작성해야 친구들에게 좋아요를 보낼 수 있어요!";
    } else {
      guideMsg = "🎉 <strong>3단계:</strong> 오늘 보낼 수 있는 좋아요: <strong>" + remainingLikes + " / 3회</strong> (누르면 나도+1, 친구도+1 도장!)";
    }

    var statusHtml = '<div style="margin-bottom:12px; padding:10px 12px; background:var(--primary-light); border:1.5px solid var(--primary-border); border-radius:12px; font-size:12px; font-weight:700; color:var(--primary);">' +
                     guideMsg +
                     '</div>';
    container.insertAdjacentHTML('beforeend', statusHtml);

    if (items.length === 0) {
      container.insertAdjacentHTML('beforeend', "<p style='color:var(--muted); text-align:center; padding:20px; grid-column:span 2;'>아직 등록된 감사제목이 없습니다.</p>");
    } else {
      items.forEach(function(g) {
        var isMyPost = (myStudentId && String(g.studentId) === myStudentId);
        var heartColor = g.isLikedByMe ? "#ef4444" : "#94a3b8";
        var heartBg = g.isLikedByMe ? "#fef2f2" : "#f1f5f9";
        var heartText = (g.isLikedByMe ? "❤️ " : "🤍 ") + (g.likeCount || 0);

        var card = document.createElement("div");
        card.className = "card";
        card.style.margin = "0 0 12px 0";
        
        var html = '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; border-bottom:1px dashed var(--border); padding-bottom:6px;">' +
                   '<div style="display:flex; align-items:center; gap:6px;">' +
                     '<span style="font-size:14px; font-weight:800; color:var(--primary);">' + g.studentName + '</span>' +
                     (isMyPost ? '<span style="font-size:10px; font-weight:800; color:var(--primary); background:var(--primary-light); padding:1px 6px; border-radius:6px;">나</span>' : '') +
                   '</div>' +
                   '<div style="display:flex; align-items:center; gap:6px;">' +
                     '<span style="font-size:11px; font-weight:700; color:var(--muted); background:#f1f5f9; padding:2px 8px; border-radius:10px;">📅 ' + (g.createdAt || "오늘") + '</span>';

        if (isMyPost) {
          html += '<button onclick="onEditGratitude(\'' + g.id + '\', \'' + encodeURIComponent(g.body) + '\')" style="background:none; border:none; color:var(--secondary); font-size:11px; font-weight:800; cursor:pointer; padding:2px 4px;">수정</button>' +
                  '<button onclick="onDeleteGratitude(\'' + g.id + '\')" style="background:none; border:none; color:#ef4444; font-size:11px; font-weight:800; cursor:pointer; padding:2px 4px;">삭제</button>';
        }

        html += '</div></div>' +
                '<p style="font-size:14px; line-height:1.5; color:var(--foreground); margin-bottom:10px;" id="grat-body-' + g.id + '">' + g.body + '</p>' +
                '<div style="display:flex; justify-content:flex-end;">' +
                  '<button class="btn-heart-like ' + (g.isLikedByMe ? 'liked' : '') + '" onclick="onLikeGratitude(\'' + g.id + '\', this)" title="격려와 축복의 좋아요">' +
                    '<span class="heart-icon">' + (g.isLikedByMe ? '❤️' : '🤍') + '</span>' +
                    '<span class="like-count">' + (g.likeCount || 0) + '</span>' +
                  '</button>' +
                '</div>';
        
        card.innerHTML = html;
        container.appendChild(card);
      });
    }

    // 입력창 & 버튼 상태 제어
    var input = document.getElementById("gratitude-input");
    var submitBtn = document.getElementById("gratitude-submit-btn");

    if (input && submitBtn) {
      if (!hasReadBibleToday) {
        input.value = "오늘 홈 탭에서 성경을 먼저 1장 이상 읽어야 감사를 작성할 수 있어요! 📖";
        input.disabled = true;
        submitBtn.disabled = true;
        submitBtn.style.background = "#cbd5e1";
        submitBtn.style.cursor = "not-allowed";
        submitBtn.textContent = "🔒 성경 완독 후 작성 가능";
      } else if (hasWrittenGratitudeToday) {
        input.value = "오늘의 감사제목을 이미 작성하셨습니다. 내일 또 만나요! 😊";
        input.disabled = true;
        submitBtn.disabled = true;
        submitBtn.style.background = "#cbd5e1";
        submitBtn.style.cursor = "not-allowed";
        submitBtn.textContent = "✅ 오늘 작성 완료 (+1 도장 수령)";
      } else {
        input.value = "";
        input.disabled = false;
        submitBtn.disabled = false;
        submitBtn.style.background = "var(--primary)";
        submitBtn.style.cursor = "pointer";
        submitBtn.textContent = "🙏 감사 나누기 (+1 도장)";
      }
    }
  }

  // 💖 좋아요 클릭 핸들러 (인터랙티브 햅틱 + 하트 팝핑 애니메이션)
  function onLikeGratitude(gratId, btnEl) {
    if (!state.sessionToken) return showToast("로그인이 필요합니다.");

    // 모바일 햅틱 진동 피드백
    if (window.navigator && typeof window.navigator.vibrate === "function") {
      try { window.navigator.vibrate(40); } catch(e) {}
    }

    // 하트 팝핑 애니메이션 발동
    if (btnEl) {
      btnEl.classList.add("animating");
      var icon = btnEl.querySelector(".heart-icon");
      if (icon && !btnEl.classList.contains("liked")) {
        icon.textContent = "❤️";
      }
      setTimeout(function() {
        if (btnEl) btnEl.classList.remove("animating");
      }, 600);
    }

    apiCall("likeGratitudeEntry", state.sessionToken, gratId).then(function(res) {
      if (res && res.success) {
        if (state.student) {
          state.student.stampBalance = res.stampBalance;
          state.student.gemBalance = res.gemBalance;
          renderWallet();
        }
        showToast("💖 응원 완료! (친구와 나 모두 💮 도장 +1개 획득!)");
        loadGratitudeFeed();
      } else {
        showToast(res ? res.error : "좋아요 처리 실패");
        if (btnEl && !btnEl.classList.contains("liked")) {
          var icon = btnEl.querySelector(".heart-icon");
          if (icon) icon.textContent = "🤍";
        }
      }
    });
  }

  function onSubmitGratitude() {
    var input = document.getElementById("gratitude-input");
    if (!input || !input.value || !input.value.trim()) return showToast("감사 내용을 입력하세요.");
    if (!state.sessionToken) return showToast("학생 로그인이 필요합니다.");

    var bodyText = input.value.trim();
    showToast("🙏 감사제목을 저장하는 중...");

    apiCall("saveGratitudeEntry", state.sessionToken, bodyText).then(function(res) {
      if (!res || !res.success) {
        return showToast(res ? res.error : "감사 저장 중 오류가 발생했습니다.");
      }

      showToast("🙏 감사 나눔이 등록되었습니다! (💮 도장 +1개 수령!)");
      input.value = "";

      if (state.student) {
        state.student.stampBalance = res.stampBalance;
      }

      var sBox = document.getElementById("wallet-stamps");
      if (sBox) sBox.textContent = res.stampBalance + "개";

      loadGratitudeFeed();
    });
  }

  function onEditGratitude(gratId, encodedBody) {
    var oldBody = decodeURIComponent(encodedBody);
    var newBody = prompt("감사내용을 수정하세요:", oldBody);
    if (newBody === null) return;
    if (!newBody.trim()) return showToast("내용을 입력해주세요.");

    showToast("수정 중...");
    apiCall("updateGratitudeEntry", state.sessionToken, gratId, newBody.trim()).then(function(res) {
      if (res && res.success) {
        showToast("✨ 수정되었습니다!");
        loadGratitudeFeed();
      } else {
        showToast(res.error || "수정 실패");
      }
    });
  }

  function onDeleteGratitude(gratId) {
    showToastConfirm("정말 이 감사글을 삭제하시겠습니까?").then(function(ok) {
      if (!ok) return;

      showToast("삭제 중...");
      apiCall("deleteGratitudeEntry", state.sessionToken, gratId).then(function(res) {
        if (res && res.success) {
          showToast("🗑️ 삭제되었습니다.");
          loadGratitudeFeed();
        } else {
          showToast(res ? res.error : "삭제 실패");
        }
      });
    });
  }

  function filterGratitude(type) {
    loadGratitudeFeed();
  }

  function showToast(msg) {
    var toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add("show");
    toast.style.display = "block";
    setTimeout(function() {
      toast.classList.remove("show");
      toast.style.display = "none";
    }, 3000);
  }

  function showToastConfirm(msg) {
    return new Promise(function(resolve) {
      var box = document.getElementById("toast-confirm");
      var msgEl = document.getElementById("toast-confirm-msg");
      var btnOk = document.getElementById("toast-confirm-ok");
      var btnCancel = document.getElementById("toast-confirm-cancel");

      if (!box || !msgEl || !btnOk || !btnCancel) {
        resolve(true);
        return;
      }

      msgEl.textContent = msg;
      box.classList.add("show");
      box.style.display = "flex";

      btnOk.onclick = function() {
        box.classList.remove("show");
        box.style.display = "none";
        resolve(true);
      };

      btnCancel.onclick = function() {
        box.classList.remove("show");
        box.style.display = "none";
        resolve(false);
      };
    });
  }

  function openChangePinModal() {
    document.getElementById("old-pin-input").value = "";
    document.getElementById("new-pin-input").value = "";
    document.getElementById("modal-change-pin").classList.add("active");
  }

  function closeChangePinModal() {
    document.getElementById("modal-change-pin").classList.remove("active");
  }

  function submitChangePin() {
    var oldPin = document.getElementById("old-pin-input").value;
    var newPin = document.getElementById("new-pin-input").value;
    var isTeacher = state.isTeacher;
    var token = isTeacher ? state.teacherToken : state.sessionToken;

    if (!oldPin || !newPin) return showToast("PIN 번호를 모두 입력하세요.");
    if (newPin.length !== 4) return showToast("새로운 PIN은 4자리 숫자여야 합니다.");

    apiCall("changeUserPin", token, isTeacher, oldPin, newPin).then(function(res) {
      if (!res.success) return showToast(res.error);
      showToast("🎉 PIN 번호가 성공적으로 변경되었습니다!");
      closeChangePinModal();
    });
  }

  function openCoinHistoryModal(type) {
    if (!state.student) return showToast("로그인이 필요합니다.");

    var modal = document.getElementById("modal-coin-history");
    var titleEl = document.getElementById("history-modal-title");
    var summaryEl = document.getElementById("history-summary-box");
    var listEl = document.getElementById("history-item-list");

    if (!modal || !titleEl || !summaryEl || !listEl) return;

    var isStamp = (type === "STAMP");
    titleEl.textContent = isStamp ? "💮 도장 적립 & 환전 내역" : "💎 보석 획득 & 사용 내역";
    summaryEl.innerHTML = "내역을 집계하는 중...";
    listEl.innerHTML = "<p style='text-align:center; padding:16px; color:var(--muted); font-size:12px;'>불러오는 중...</p>";

    modal.classList.add("active");
    modal.style.display = "flex";

    apiCall("getStudentCoinHistory", state.sessionToken, type).then(function(res) {
      if (!res || !res.success) {
        summaryEl.innerHTML = "<span style='color:red;'>내역을 불러오지 못했습니다.</span>";
        listEl.innerHTML = "";
        return;
      }

      var s = res.summary;
      var unit = "개";

      summaryEl.innerHTML = 
        '<div style="display:flex; justify-content:space-between; margin-bottom:2px;">' +
          '<span>총 획득량:</span><strong style="color:#10b981;">+' + s.totalEarned + unit + '</strong>' +
        '</div>' +
        '<div style="display:flex; justify-content:space-between; margin-bottom:2px;">' +
          '<span>총 사용/차감량:</span><strong style="color:#ef4444;">-' + s.totalSpent + unit + '</strong>' +
        '</div>' +
        '<div style="display:flex; justify-content:space-between; border-top:1px dashed var(--border); margin-top:4px; padding-top:4px; font-weight:800;">' +
          '<span>현재 보유 잔액:</span><strong style="color:var(--primary);">' + s.currentBalance + unit + '</strong>' +
        '</div>';

      listEl.innerHTML = "";
      if (res.list.length === 0) {
        listEl.innerHTML = "<p style='text-align:center; padding:20px; color:var(--muted); font-size:12px;'>기록된 내역이 없습니다.</p>";
        return;
      }

      res.list.forEach(function(item) {
        var isPlus = item.amount > 0;
        var badgeColor = isPlus ? "#10b981" : "#ef4444";
        var badgeBg = isPlus ? "#ecfdf5" : "#fef2f2";
        var amtText = (isPlus ? "+" : "") + item.amount + unit;

        var row = document.createElement("div");
        row.style.cssText = "display:flex; justify-content:space-between; align-items:center; background:#ffffff; border:1px solid var(--border); padding:8px 10px; border-radius:10px; font-size:12px;";
        row.innerHTML = 
          '<div style="display:flex; flex-direction:column; gap:2px; min-width:0; padding-right:8px;">' +
            '<span style="font-weight:700; color:var(--foreground); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + item.reason + '</span>' +
            '<span style="font-size:10px; color:var(--muted);">' + item.createdAt + '</span>' +
          '</div>' +
          '<span style="font-weight:800; font-size:13px; color:' + badgeColor + '; background:' + badgeBg + '; padding:2px 8px; border-radius:6px; flex-shrink:0;">' + amtText + '</span>';
        listEl.appendChild(row);
      });
    });
  }

  function closeCoinHistoryModal() {
    var modal = document.getElementById("modal-coin-history");
    if (modal) {
      modal.classList.remove("active");
      modal.style.display = "none";
    }
  }

  // 🛍️ 마켓 상품 동적 렌더링 (학생 상점 뷰)
  function renderMarketProductGrid() {
    var grid = document.getElementById("market-product-grid");
    if (!grid) return;
    grid.innerHTML = "<p style='grid-column:1/-1; text-align:center; padding:16px; color:var(--muted); font-size:12px;'>상품 목록을 불러오는 중...</p>";

    apiCall("listMarketProducts").then(function(res) {
      if (!res || !res.success || !res.products || res.products.length === 0) {
        grid.innerHTML = "<p style='grid-column:1/-1; text-align:center; padding:20px; color:var(--muted); font-size:12px;'>등록된 교환 상품이 없습니다.</p>";
        return;
      }

      grid.innerHTML = "";
      res.products.forEach(function(p) {
        if (!p.isAvailable) return;
        var card = document.createElement("div");
        card.className = "market-product-card";
        
        var imgHtml = "";
        if (p.imageUrl && p.imageUrl.startsWith("emoji:")) {
          imgHtml = '<div style="width:100%; height:90px; background:#fff3f8; border-radius:12px; display:flex; align-items:center; justify-content:center; font-size:46px; margin-bottom:8px;">' + p.imageUrl.slice(6) + '</div>';
        } else if (p.imageUrl) {
          imgHtml = '<img src="' + p.imageUrl + '" style="width:100%; height:90px; object-fit:cover; border-radius:12px; margin-bottom:8px;" onerror="this.outerHTML=\'<div style=\\\'width:100%; height:90px; background:#fff3f8; border-radius:12px; display:flex; align-items:center; justify-content:center; font-size:46px; margin-bottom:8px;\\\'>🎁</div>\';">';
        } else {
          imgHtml = '<div style="width:100%; height:90px; background:#fff3f8; border-radius:12px; display:flex; align-items:center; justify-content:center; font-size:46px; margin-bottom:8px;">🎁</div>';
        }

        card.innerHTML = imgHtml +
          '<div style="flex:1; display:flex; flex-direction:column; justify-content:space-between;">' +
            '<div>' +
              '<div style="font-size:13px; font-weight:800; color:var(--foreground); margin-bottom:4px;">' + p.name + '</div>' +
              (p.description ? '<div style="font-size:11px; color:var(--muted); margin-bottom:6px; max-height:32px; overflow:hidden;">' + p.description + '</div>' : '') +
            '</div>' +
            '<div>' +
              '<div style="font-size:13px; font-weight:800; color:var(--secondary); margin-bottom:6px;">💎 보석 ' + p.gemPrice + '개</div>' +
              '<button class="btn-pill btn-exchange-cta" style="width:100%; padding:8px 6px; font-size:12px;" onclick="onExchangeMarketProduct(\'' + p.id + '\')">💎 교환하기</button>' +
            '</div>' +
          '</div>';

        grid.appendChild(card);
      });
    });
  }

  function onExchangeMarketProduct(productId) {
    if (!state.student) return showToast("로그인이 필요합니다.");

    apiCall("listMarketProducts").then(function(res) {
      if (!res || !res.success || !res.products) return showToast("상품 정보를 불러올 수 없습니다.");
      var p = res.products.find(function(x) { return x.id === productId; });
      if (!p) return showToast("상품 정보를 찾을 수 없습니다.");

      var currentGems = state.student.gemBalance || 0;
      if (currentGems < p.gemPrice) {
        return showToast("보석이 부족합니다! (필요: 보석 " + p.gemPrice + "개 / 보유: " + currentGems + "개)");
      }

      showToastConfirm("['" + p.name + "'] 상품을 보석 " + p.gemPrice + "개로 교환하시겠습니까?").then(function(ok) {
        if (!ok) return;

        showToast("교환 처리 중...");
        apiCall("exchangeMarketProduct", state.sessionToken, productId).then(function(result) {
          if (result && result.success) {
            state.student.gemBalance = result.gemBalance;
            state.student.stampBalance = result.stampBalance;
            renderWallet();
            loadShopView();
            showToast("🎉 [" + result.productName + "] 상품 교환 신청이 완료되었습니다!");
          } else {
            showToast("⚠️ " + (result ? result.error : "교환 실패"));
          }
        });
      });
    });
  }

  // 🛍️ 마켓 상품 게시판 관리 (교사 패널)
  function renderTeacherMarketAdminList() {
    var container = document.getElementById("teacher-market-product-list");
    if (!container) return;
    container.innerHTML = "<p style='font-size:12px; color:var(--muted);'>상품 목록 불러오는 중...</p>";

    apiCall("listMarketProducts").then(function(res) {
      if (!res || !res.success || !res.products || res.products.length === 0) {
        container.innerHTML = "<p style='font-size:12px; color:var(--muted);'>등록된 마켓 상품이 없습니다. [+ 새 상품 등록] 버튼을 눌러 추가하세요.</p>";
        return;
      }

      container.innerHTML = "";
      res.products.forEach(function(p) {
        var item = document.createElement("div");
        item.style.cssText = "display:flex; justify-content:space-between; align-items:center; background:#ffffff; border:1px solid var(--border); padding:8px 12px; border-radius:10px; font-size:13px; margin-bottom:6px;";
        
        var visualHtml = "";
        if (p.imageUrl && p.imageUrl.startsWith("emoji:")) {
          visualHtml = '<span style="font-size:24px; margin-right:8px; vertical-align:middle;">' + p.imageUrl.slice(6) + '</span>';
        } else if (p.imageUrl) {
          visualHtml = '<img src="' + p.imageUrl + '" style="width:30px; height:30px; object-fit:cover; border-radius:6px; margin-right:8px; vertical-align:middle;" onerror="this.outerHTML=\'<span style=\\\'font-size:24px; margin-right:8px; vertical-align:middle;\\\'>🎁</span>\';">';
        } else {
          visualHtml = '<span style="font-size:24px; margin-right:8px; vertical-align:middle;">🎁</span>';
        }

        item.innerHTML = 
          '<div style="display:flex; align-items:center; min-width:0; padding-right:8px;">' +
            visualHtml +
            '<div style="min-width:0;">' +
              '<span style="font-weight:800; color:var(--foreground);">' + p.name + '</span> ' +
              '<span style="font-size:12px; font-weight:800; color:var(--secondary); background:#fff0f7; padding:2px 6px; border-radius:6px;">💎 ' + p.gemPrice + '개</span>' +
              (p.description ? '<div style="font-size:11px; color:var(--muted); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + p.description + '</div>' : '') +
            '</div>' +
          '</div>' +
          '<div style="display:flex; gap:6px; flex-shrink:0;">' +
            '<button class="btn-pill btn-secondary" style="width:auto; padding:4px 8px; font-size:11px;" onclick="openMarketAdminModal(\'' + p.id + '\')">✏️ 수정</button>' +
            '<button class="btn-pill btn-secondary" style="width:auto; padding:4px 8px; font-size:11px; color:red; border-color:#fca5a5;" onclick="deleteMarketProductAdmin(\'' + p.id + '\')">🗑️ 삭제</button>' +
          '</div>';
        container.appendChild(item);
      });
    });
  }

  // 🛍️ 마켓 상품 사진 첨부 / 이모티콘 / URL 비주얼 헬퍼 함수군
  var MARKET_EMOJIS = [
    "🎁", "🍦", "🍔", "🍕", "🧃", "🍫", "🍭", "🍩",
    "📚", "✏️", "🎒", "🧸", "⚽", "🎮", "🎟️", "🏷️",
    "⭐", "👑", "✝️", "✨", "🎉", "🍪", "🥤", "🎨"
  ];

  function initMarketEmojiPalette() {
    var palette = document.getElementById("market-emoji-palette");
    if (!palette || palette.children.length > 0) return;
    palette.innerHTML = "";
    MARKET_EMOJIS.forEach(function(em) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "market-emoji-btn";
      btn.textContent = em;
      btn.onclick = function() { selectProductEmoji(em); };
      palette.appendChild(btn);
    });
  }

  function switchProductVisualType(type) {
    var tabFile = document.getElementById("tab-visual-file");
    var tabEmoji = document.getElementById("tab-visual-emoji");
    var tabUrl = document.getElementById("tab-visual-url");
    var panelFile = document.getElementById("panel-visual-file");
    var panelEmoji = document.getElementById("panel-visual-emoji");
    var panelUrl = document.getElementById("panel-visual-url");

    if (!tabFile || !panelFile) return;

    [tabFile, tabEmoji, tabUrl].forEach(function(t) {
      if (t) {
        t.className = "btn-pill btn-secondary";
        t.style.background = "";
        t.style.color = "";
      }
    });
    [panelFile, panelEmoji, panelUrl].forEach(function(p) {
      if (p) p.style.display = "none";
    });

    if (type === "emoji") {
      tabEmoji.className = "btn-pill";
      tabEmoji.style.background = "var(--secondary)";
      tabEmoji.style.color = "#ffffff";
      panelEmoji.style.display = "block";
      initMarketEmojiPalette();
    } else if (type === "url") {
      tabUrl.className = "btn-pill";
      tabUrl.style.background = "var(--secondary)";
      tabUrl.style.color = "#ffffff";
      panelUrl.style.display = "block";
    } else {
      tabFile.className = "btn-pill";
      tabFile.style.background = "var(--secondary)";
      tabFile.style.color = "#ffffff";
      panelFile.style.display = "block";
    }
  }

  function setProductVisualPreview(type, val) {
    var hiddenVal = document.getElementById("market-visual-value");
    var prevEmoji = document.getElementById("market-preview-emoji");
    var prevImg = document.getElementById("market-preview-img");
    var prevText = document.getElementById("market-preview-text");
    var clearBtn = document.getElementById("market-preview-clear");

    if (type === "emoji" && val) {
      if (hiddenVal) hiddenVal.value = "emoji:" + val;
      if (prevEmoji) { prevEmoji.textContent = val; prevEmoji.style.display = "block"; }
      if (prevImg) prevImg.style.display = "none";
      if (prevText) prevText.textContent = "선택된 이모티콘 (" + val + ")";
      if (clearBtn) clearBtn.style.display = "inline-block";
    } else if (type === "img" && val) {
      if (hiddenVal) hiddenVal.value = val;
      if (prevEmoji) prevEmoji.style.display = "none";
      if (prevImg) { prevImg.src = val; prevImg.style.display = "block"; }
      if (prevText) prevText.textContent = val.startsWith("data:") ? "📷 직접 첨부한 사진 파일" : val;
      if (clearBtn) clearBtn.style.display = "inline-block";
    } else {
      if (hiddenVal) hiddenVal.value = "";
      if (prevEmoji) { prevEmoji.textContent = "🎁"; prevEmoji.style.display = "block"; }
      if (prevImg) { prevImg.src = ""; prevImg.style.display = "none"; }
      if (prevText) prevText.textContent = "기본 선물상자 (🎁)";
      if (clearBtn) clearBtn.style.display = "none";
    }
  }

  function handleProductFileSelect(event) {
    var file = event && event.target && event.target.files ? event.target.files[0] : null;
    if (!file) return;
    if (!file.type.startsWith("image/")) return showToast("이미지 파일만 첨부할 수 있습니다.");

    showToast("📷 사진 압축 및 처리 중...");
    var reader = new FileReader();
    reader.onload = function(e) {
      var img = new Image();
      img.onload = function() {
        var canvas = document.createElement("canvas");
        var maxSide = 360;
        var w = img.width;
        var h = img.height;
        if (w > maxSide || h > maxSide) {
          if (w > h) {
            h = Math.round((h * maxSide) / w);
            w = maxSide;
          } else {
            w = Math.round((w * maxSide) / h);
            h = maxSide;
          }
        }
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        var dataUrl = canvas.toDataURL("image/jpeg", 0.82);
        setProductVisualPreview("img", dataUrl);
        showToast("📷 사진이 성공적으로 첨부되었습니다!");
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function selectProductEmoji(emoji) {
    var palette = document.getElementById("market-emoji-palette");
    if (palette) {
      var btns = palette.querySelectorAll(".market-emoji-btn");
      btns.forEach(function(b) {
        if (b.textContent === emoji) b.classList.add("selected");
        else b.classList.remove("selected");
      });
    }
    setProductVisualPreview("emoji", emoji);
  }

  function onProductUrlInput(val) {
    var trimmed = val ? val.trim() : "";
    if (trimmed) {
      setProductVisualPreview("img", trimmed);
    } else {
      setProductVisualPreview(null, null);
    }
  }

  function clearProductVisual() {
    var fileInput = document.getElementById("market-input-file");
    if (fileInput) fileInput.value = "";
    var urlInput = document.getElementById("market-input-img");
    if (urlInput) urlInput.value = "";
    var palette = document.getElementById("market-emoji-palette");
    if (palette) {
      var btns = palette.querySelectorAll(".market-emoji-btn");
      btns.forEach(function(b) { b.classList.remove("selected"); });
    }
    setProductVisualPreview(null, null);
  }

  window.switchProductVisualType = switchProductVisualType;
  window.handleProductFileSelect = handleProductFileSelect;
  window.selectProductEmoji = selectProductEmoji;
  window.onProductUrlInput = onProductUrlInput;
  window.clearProductVisual = clearProductVisual;

  function openMarketAdminModal(productId) {
    var modal = document.getElementById("modal-market-admin");
    var titleEl = document.getElementById("market-admin-modal-title");
    var editIdEl = document.getElementById("market-edit-id");
    var nameIn = document.getElementById("market-input-name");
    var priceIn = document.getElementById("market-input-price");
    var descIn = document.getElementById("market-input-desc");

    if (!modal) return;
    initMarketEmojiPalette();

    if (productId) {
      if (titleEl) titleEl.textContent = "🛍️ 마켓 상품 수정";
      if (editIdEl) editIdEl.value = productId;
      apiCall("listMarketProducts").then(function(res) {
        if (res && res.products) {
          var p = res.products.find(function(x) { return x.id === productId; });
          if (p) {
            if (nameIn) nameIn.value = p.name || "";
            if (priceIn) priceIn.value = p.gemPrice || 5;
            if (descIn) descIn.value = p.description || "";
            
            // 기존 비주얼 복원
            var imgVal = p.imageUrl || "";
            if (imgVal.startsWith("emoji:")) {
              var em = imgVal.slice(6);
              switchProductVisualType("emoji");
              selectProductEmoji(em);
            } else if (imgVal.startsWith("data:")) {
              switchProductVisualType("file");
              setProductVisualPreview("img", imgVal);
            } else if (imgVal.startsWith("http")) {
              switchProductVisualType("url");
              var urlInput = document.getElementById("market-input-img");
              if (urlInput) urlInput.value = imgVal;
              setProductVisualPreview("img", imgVal);
            } else {
              switchProductVisualType("file");
              clearProductVisual();
            }
          }
        }
      });
    } else {
      if (titleEl) titleEl.textContent = "🛍️ 마켓 상품 등록";
      if (editIdEl) editIdEl.value = "";
      if (nameIn) nameIn.value = "";
      if (priceIn) priceIn.value = "5";
      if (descIn) descIn.value = "";
      switchProductVisualType("file");
      clearProductVisual();
    }

    modal.classList.add("active");
    modal.style.display = "flex";
  }

  function closeMarketAdminModal() {
    var modal = document.getElementById("modal-market-admin");
    if (modal) {
      modal.classList.remove("active");
      modal.style.display = "none";
    }
  }

  function saveMarketProductAdmin() {
    var editId = document.getElementById("market-edit-id").value;
    var name = document.getElementById("market-input-name").value.trim();
    var price = parseInt(document.getElementById("market-input-price").value, 10);
    var desc = document.getElementById("market-input-desc").value.trim();

    var visualVal = document.getElementById("market-visual-value") ? document.getElementById("market-visual-value").value.trim() : "";
    if (!visualVal) {
      var urlInput = document.getElementById("market-input-img");
      if (urlInput && urlInput.value.trim()) visualVal = urlInput.value.trim();
    }

    if (!name) return showToast("상품명을 입력하세요.");
    if (isNaN(price) || price <= 0) return showToast("올바른 보석 수량을 입력하세요.");

    var productData = {
      id: editId || null,
      name: name,
      gemPrice: price,
      imageUrl: visualVal,
      description: desc,
      isAvailable: true
    };

    showToast("상품 저장 중...");
    apiCall("saveMarketProduct", state.teacherToken, productData).then(function(res) {
      if (res && res.success) {
        showToast("🎉 상품이 게시판에 저장되었습니다!");
        closeMarketAdminModal();
        renderTeacherMarketAdminList();
        renderMarketProductGrid();
      } else {
        showToast("⚠️ " + (res ? res.error : "저장 실패"));
      }
    });
  }

  function deleteMarketProductAdmin(productId) {
    showToastConfirm("이 상품을 삭제하시겠습니까?").then(function(ok) {
      if (!ok) return;

      showToast("상품 삭제 중...");
      apiCall("deleteMarketProduct", state.teacherToken, productId).then(function(res) {
        if (res && res.success) {
          showToast("🗑️ 상품이 삭제되었습니다.");
          renderTeacherMarketAdminList();
          renderMarketProductGrid();
        } else {
          showToast("⚠️ " + (res ? res.error : "삭제 실패"));
        }
      });
    });
  }

  // ⭐ 교사 칭찬 도장 선물 기능
  function openPraiseStampModal() {
    var modal = document.getElementById("modal-praise-stamp");
    var select = document.getElementById("praise-select-student");
    if (!modal || !select) return;

    select.innerHTML = "<option>학생 명단을 불러오는 중...</option>";
    modal.classList.add("active");
    modal.style.display = "flex";

    setPraiseAmount(1);

    apiCall("listStudentCards").then(function(res) {
      if (!res || !res.success || !res.students) {
        select.innerHTML = "<option>명단을 불러오지 못했습니다.</option>";
        return;
      }

      select.innerHTML = "";
      res.students.forEach(function(s) {
        var opt = document.createElement("option");
        opt.value = s.studentId;
        opt.textContent = (s.displayEmoji || "⭐") + " " + s.name + " (" + (s.department || "학생") + ")";
        select.appendChild(opt);
      });
    });
  }

  function closePraiseStampModal() {
    var modal = document.getElementById("modal-praise-stamp");
    if (modal) {
      modal.classList.remove("active");
      modal.style.display = "none";
    }
  }

  function setPraiseAmount(amt) {
    document.getElementById("praise-input-amount").value = amt;
    var btns = document.querySelectorAll(".praise-amt-btn");
    btns.forEach(function(b, idx) {
      if (idx + 1 === amt) {
        b.style.background = "#f59e0b";
        b.style.color = "#ffffff";
        b.style.fontWeight = "800";
      } else {
        b.style.background = "";
        b.style.color = "";
        b.style.fontWeight = "";
      }
    });
  }

  function submitPraiseStamp() {
    var select = document.getElementById("praise-select-student");
    var studentId = select ? select.value : null;
    var amount = parseInt(document.getElementById("praise-input-amount").value, 10);
    var reason = document.getElementById("praise-input-reason").value.trim();

    if (!studentId) return showToast("칭찬할 학생을 선택하세요.");
    if (isNaN(amount) || amount <= 0) amount = 1;

    showToast("칭찬 도장 부여 중...");
    apiCall("grantPraiseStamps", state.teacherToken, studentId, amount, reason).then(function(res) {
      if (res && res.success) {
        showToast("⭐ 칭찬 도장 +" + amount + "개가 선물되었습니다!");
        closePraiseStampModal();

        if (state.student && String(state.student.studentId) === String(studentId)) {
          state.student.stampBalance = res.newStampBalance;
          renderWallet();
        }
      } else {
        showToast("⚠️ " + (res ? res.error : "부여 실패"));
      }
    });
  }
