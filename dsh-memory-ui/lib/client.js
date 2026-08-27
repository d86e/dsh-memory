window.__ModuleLoader__.load({
	id: "dsh-memory-ui",
	factory: function(require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_slots = require("@deepseek-ai/dsh-client-ui-slots");
		let _deepseek_ai_dsh_client_locale = require("@deepseek-ai/dsh-client-locale");
		const { useState, useEffect, useCallback } = react;

		const LAYERS = [
			{ id: 4, label: 'L4 深层', color: '#7c3aed', desc: '原则与决策' },
			{ id: 3, label: 'L3 整理', color: '#2563eb', desc: '结构化摘要' },
			{ id: 2, label: 'L2 关键', color: '#16a34a', desc: '原始事实' },
			{ id: 1, label: 'L1 原始', color: '#6b7280', desc: '对话原文' },
		];
		const TRACKS = ['global', 'project', 'user', 'daily'];

		function MemoryPanel({ memoryService, reload }) {
			const [memories, setMemories] = useState([]);
			const [filtered, setFiltered] = useState([]);
			const [search, setSearch] = useState('');
			const [layerFilter, setLayerFilter] = useState(null);
			const [editingId, setEditingId] = useState(null);
			const [editContent, setEditContent] = useState('');
			const [showAdd, setShowAdd] = useState(false);
			const [newContent, setNewContent] = useState('');
			const [newLayer, setNewLayer] = useState(3);
			const [newTrack, setNewTrack] = useState('user');
			const [stats, setStats] = useState({ total: 0, byLayer: {} });
			const [loading, setLoading] = useState(true);
			const [toast, setToast] = useState(null);

			const flash = useCallback((msg) => {
				setToast(msg);
				setTimeout(() => setToast(null), 2000);
			}, []);

			const loadMemories = useCallback(async () => {
				try {
					setLoading(true);
					const resp = await fetch('/api/memory/list');
					const list = await resp.json();
					const valid = (Array.isArray(list) ? list : []).filter(m => (m.priority ?? 0) > 0);
					setMemories(valid);
					const byLayer = {};
					valid.forEach(m => { byLayer[m.layer] = (byLayer[m.layer] || 0) + 1; });
					setStats({ total: valid.length, byLayer });
					applyFilter(valid, search, layerFilter);
				} catch (e) {
					flash('加载失败: ' + e.message);
				} finally {
					setLoading(false);
				}
			}, [flash]);

			useEffect(() => { loadMemories(); }, [loadMemories]);

			const applyFilter = useCallback((items, q, layer) => {
				let result = items;
				if (layer !== null) result = result.filter(m => m.layer === layer);
				if (q.trim()) {
					const term = q.toLowerCase();
					result = result.filter(m => m.content.toLowerCase().includes(term));
				}
				setFiltered(result);
			}, []);

			useEffect(() => { applyFilter(memories, search, layerFilter); }, [memories, search, layerFilter, applyFilter]);

			const handleAdd = useCallback(async () => {
				if (!newContent.trim()) return;
				try {
					const resp = await fetch('/api/memory/add', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ content: newContent.trim(), layer: newLayer, track: newTrack, priority: 3 }) });
					const m = await resp.json();
					flash('已添加 #' + m.id);
					setNewContent('');
					setShowAdd(false);
					reload();
				} catch (e) { flash('添加失败: ' + e.message); }
			}, [newContent, newLayer, newTrack, flash, reload]);

			const handleSave = useCallback(async (id) => {
				if (!editContent.trim()) return;
				try {
					await fetch('/api/memory/update', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ id, changes: { content: editContent.trim() } }) });
					setEditingId(null);
					flash('已更新');
					reload();
				} catch (e) { flash('更新失败: ' + e.message); }
			}, [editContent, flash, reload]);

			const handleDelete = useCallback(async (id) => {
				if (false) return;
				try {
					await fetch('/api/memory/remove', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ id }) });
					flash('已删除');
					reload();
				} catch (e) { flash('删除失败: ' + e.message); }
			}, [flash, reload]);

			const handleSearch = useCallback(async (q) => {
				if (!q.trim()) return;
				try {
					const resp = await fetch('/api/memory/search?query=' + encodeURIComponent(q) + '&limit=50');
					const result = await resp.json();
					const items = (result.results || []).map(r => ({ ...r, priority: r.priority ?? 3 }));
					setMemories(items);
					applyFilter(items, q, layerFilter);
				} catch (e) { flash('搜索失败: ' + e.message); }
			}, [flash, applyFilter, layerFilter]);

			const layerCounts = LAYERS.map(l => ({ ...l, count: stats.byLayer[l.id] || 0 }));

			return react_jsx_runtime.jsx("div", { style: S.root, children: [
				toast && react_jsx_runtime.jsx("div", { style: S.toast, children: toast }),
				react_jsx_runtime.jsx("div", { style: S.header, children: [
					react_jsx_runtime.jsx("div", { style: S.titleRow, children: [
						react_jsx_runtime.jsx("span", { style: S.title, children: "🧠 记忆" }),
						react_jsx_runtime.jsx("span", { style: S.badge, children: stats.total + " 条" }),
					]}),
					react_jsx_runtime.jsx("div", { style: S.statsRow, children: layerCounts.filter(l => l.count > 0).map(l =>
						react_jsx_runtime.jsx("span", {
							style: Object.assign({}, S.layerPill, { borderColor: l.color, color: l.color, background: l.color + "18" }),
							onClick: () => setLayerFilter(layerFilter === l.id ? null : l.id),
							children: l.label + " " + l.count
						}, l.id)
					)})
				]}),
				react_jsx_runtime.jsx("div", { style: S.toolbar, children: [
					react_jsx_runtime.jsx("input", {
						style: S.searchInput, placeholder: "搜索记忆...", value: search,
						onChange: e => setSearch(e.target.value),
						onKeyDown: e => e.key === 'Enter' && handleSearch(e.target.value),
					}),
					react_jsx_runtime.jsx("button", { style: S.searchBtn, onClick: () => handleSearch(search), children: "搜索" }),
					react_jsx_runtime.jsx("button", {
						style: Object.assign({}, S.addBtn, { background: '#2563eb' }),
						onClick: () => setShowAdd(!showAdd),
						children: showAdd ? "✕" : "+ 添加"
					}),
				]}),
				showAdd ? react_jsx_runtime.jsx("div", { style: S.formCard, children: [
					react_jsx_runtime.jsx("textarea", {
						style: S.textarea, placeholder: "输入记忆内容...", value: newContent,
						onChange: e => setNewContent(e.target.value), rows: 3,
					}),
					react_jsx_runtime.jsx("div", { style: S.formRow, children: [
						react_jsx_runtime.jsx("select", { style: S.select, value: newLayer, onChange: e => setNewLayer(Number(e.target.value)),
							children: LAYERS.map(l => react_jsx_runtime.jsx("option", { value: l.id, children: l.label }, l.id))
						}),
						react_jsx_runtime.jsx("select", { style: S.select, value: newTrack, onChange: e => setNewTrack(e.target.value),
							children: TRACKS.map(t => react_jsx_runtime.jsx("option", { value: t, children: t }, t))
						}),
						react_jsx_runtime.jsx("button", { style: S.saveBtn, onClick: handleAdd, children: "保存" }),
					]}),
				]}) : null,
				react_jsx_runtime.jsx("div", { style: S.list, children: loading
					? react_jsx_runtime.jsx("div", { style: S.empty, children: "加载中..." })
					: filtered.length === 0
						? react_jsx_runtime.jsx("div", { style: S.empty, children: "暂无记忆" })
						: filtered.map(m => {
							const lc = LAYERS.find(l => l.id === m.layer)?.color || '#6b7280';
							const isEditing = editingId === m.id;
							return react_jsx_runtime.jsx("div", {
								style: Object.assign({}, S.card, { borderLeft: "3px solid " + lc }),
								children: [
									react_jsx_runtime.jsx("div", { style: S.cardHeader, children: [
										react_jsx_runtime.jsx("span", { style: Object.assign({}, S.layerTag, { background: lc + "22", color: lc }), children: "L" + m.layer + " · " + m.track }),
										react_jsx_runtime.jsx("span", { style: S.priority, children: "⭐ priority " + (m.priority ?? 3) }),
										react_jsx_runtime.jsx("span", { style: S.time, children: new Date(m.created).toLocaleString('zh-CN') }),
									]}),
									isEditing ? react_jsx_runtime.jsx("div", { style: S.editArea, children: [
										react_jsx_runtime.jsx("textarea", { style: S.textarea, value: editContent, onChange: e => setEditContent(e.target.value), rows: 3 }),
										react_jsx_runtime.jsx("div", { style: S.editActions, children: [
											react_jsx_runtime.jsx("button", { style: S.saveBtn, onClick: () => handleSave(m.id), children: "保存" }),
											react_jsx_runtime.jsx("button", { style: S.cancelBtn, onClick: () => { setEditingId(null); setEditContent(''); }, children: "取消" }),
										]}),
									]}) : react_jsx_runtime.jsx("p", { style: S.content, children: m.content }),
									!isEditing ? react_jsx_runtime.jsx("div", { style: S.actions, children: [
										react_jsx_runtime.jsx("button", { style: S.editBtn, onClick: () => { setEditingId(m.id); setEditContent(m.content); }, children: "编辑" }),
										react_jsx_runtime.jsx("button", { style: S.deleteBtn, onClick: () => handleDelete(m.id), children: "删除" }),
									]}) : null,
								]
							}, m.id);
						})
				}),
				layerFilter ? react_jsx_runtime.jsx("div", { style: S.filterBar, children: [
					"筛选: L" + layerFilter,
					react_jsx_runtime.jsx("button", { style: S.clearBtn, onClick: () => setLayerFilter(null), children: "✕" }),
				]}) : null,
			]});
		}

		const S = {
			root: { display:'flex', flexDirection:'column', height:'100%', overflow:'hidden',
				background:'var(--dsw-alias-bg-base,#fff)', color:'var(--dsw-alias-label-primary,#111)' },
			toast: { position:'fixed', bottom:20, left:'50%', transform:'translateX(-50%)',
				background:'#111', color:'#fff', padding:'8px 20px', borderRadius:8, fontSize:13, zIndex:1000 },
			header: { padding:'12px 16px 8px', borderBottom:'1px solid var(--dsw-alias-border-l1,#e5e7eb)', flex:'none' },
			titleRow: { display:'flex', alignItems:'center', gap:8, marginBottom:8 },
			title: { fontSize:16, fontWeight:600 },
			badge: { background:'#eff6ff', color:'#2563eb', borderRadius:12, padding:'2px 8px', fontSize:12, fontWeight:500 },
			statsRow: { display:'flex', flexWrap:'wrap', gap:6 },
			layerPill: { fontSize:12, padding:'2px 10px', borderRadius:12, cursor:'pointer', border:'1px solid', fontWeight:500 },
			toolbar: { display:'flex', gap:8, padding:'10px 16px', borderBottom:'1px solid var(--dsw-alias-border-l1,#e5e7eb)', flex:'none' },
			searchInput: { flex:1, padding:'6px 12px', borderRadius:8, border:'1px solid var(--dsw-alias-border-l2,#d1d5db)',
				fontSize:13, background:'var(--dsw-alias-bg-layer-1,#f9fafb)' },
			searchBtn: { padding:'6px 14px', borderRadius:8, border:'1px solid var(--dsw-alias-border-l2,#d1d5db)',
				fontSize:13, cursor:'pointer', background:'var(--dsw-alias-bg-base,#fff)' },
			addBtn: { padding:'6px 14px', borderRadius:8, border:'none', fontSize:13, cursor:'pointer', color:'#fff', fontWeight:500 },
			formCard: { padding:'12px 16px', borderBottom:'1px solid var(--dsw-alias-border-l1,#e5e7eb)', flex:'none',
				background:'var(--dsw-alias-bg-layer-1,#f9fafb)' },
			formRow: { display:'flex', gap:8, alignItems:'center', marginTop:8 },
			textarea: { width:'100%', padding:'8px 12px', borderRadius:8, border:'1px solid var(--dsw-alias-border-l2,#d1d5db)',
				fontSize:13, resize:'vertical', background:'var(--dsw-alias-bg-base,#fff)', fontFamily:'inherit', boxSizing:'border-box' },
			select: { padding:'6px 10px', borderRadius:8, border:'1px solid var(--dsw-alias-border-l2,#d1d5db)',
				fontSize:13, background:'var(--dsw-alias-bg-base,#fff)' },
			saveBtn: { padding:'6px 16px', borderRadius:8, border:'none', background:'#16a34a', color:'#fff', fontSize:13, cursor:'pointer', fontWeight:500 },
			cancelBtn: { padding:'6px 16px', borderRadius:8, border:'1px solid var(--dsw-alias-border-l2,#d1d5db)', background:'transparent', fontSize:13, cursor:'pointer' },
			list: { flex:1, overflowY:'auto', padding:'8px 16px' },
			card: { background:'var(--dsw-alias-bg-layer-1,#f9fafb)', borderRadius:8, padding:'10px 14px', marginBottom:8,
				border:'1px solid var(--dsw-alias-border-l1,#e5e7eb)' },
			cardHeader: { display:'flex', alignItems:'center', gap:8, marginBottom:6, flexWrap:'wrap' },
			layerTag: { fontSize:11, padding:'1px 8px', borderRadius:10, fontWeight:500 },
			priority: { fontSize:11, color:'var(--dsw-alias-label-tertiary,#6b7280)' },
			time: { fontSize:11, color:'var(--dsw-alias-label-tertiary,#6b7280)', marginLeft:'auto' },
			content: { fontSize:13, margin:0, lineHeight:1.5, wordBreak:'break-word' },
			editArea: { display:'flex', flexDirection:'column', gap:8 },
			editActions: { display:'flex', gap:8 },
			actions: { display:'flex', gap:8, marginTop:8 },
			editBtn: { fontSize:12, padding:'2px 10px', borderRadius:6, border:'1px solid var(--dsw-alias-border-l2,#d1d5db)',
				background:'transparent', cursor:'pointer', color:'var(--dsw-alias-label-secondary,#374151)' },
			deleteBtn: { fontSize:12, padding:'2px 10px', borderRadius:6, border:'1px solid #fecaca',
				background:'#fef2f2', cursor:'pointer', color:'#dc2626' },
			empty: { textAlign:'center', color:'var(--dsw-alias-label-tertiary,#9ca3af)', fontSize:13, padding:'40px 0' },
			filterBar: { padding:'6px 16px', fontSize:12, color:'var(--dsw-alias-label-secondary,#374151)',
				display:'flex', alignItems:'center', gap:8 },
			clearBtn: { background:'none', border:'none', cursor:'pointer', fontSize:14, color:'#6b7280' },
		};

		const NS = 'memory-ui';
		const inject = ['slots', 'locale'];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh: { 'view.memory': '记忆' },
				en: { 'view.memory': 'Memory' },
			}), 'memory-ui: locale');

			const t = ctx.locale.bind(NS);
			
			ctx.effect(() => {
				ctx.slots.inject('conversation.view', () => ctx.slots.register({
					name: 'conversation.view',
					id: 'memory',
					order: 15,
					locale: NS,
					label: () => t('view.memory'),
					inject: (_sessionId) => ({ reload: () => {} }),
				}, MemoryPanel));
			}, 'memory-ui: slot');
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
