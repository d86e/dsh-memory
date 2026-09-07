window.__ModuleLoader__.load({
	id: "@d86e/dsh-memory",
	factory: function(require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_slots = require("@deepseek-ai/dsh-client-ui-slots");
		let _deepseek_ai_dsh_client_locale = require("@deepseek-ai/dsh-client-locale");
		const { useState, useEffect, useCallback, useMemo, useRef } = react;

		const LAYERS = [
			{ id: 4, label: 'L4 深层', color: '#7c3aed' },
			{ id: 3, label: 'L3 整理', color: '#2563eb' },
			{ id: 2, label: 'L2 关键', color: '#16a34a' },
			{ id: 1, label: 'L1 原始', color: '#6b7280' },
		];
		const TRACKS = ['global', 'project', 'user', 'daily'];
		const TRACK_COLORS = {
			global: '#dc2626', project: '#2563eb', user: '#16a34a', daily: '#f59e0b',
		};
		const PAGE_SIZE = 500;

		// ============ API 调用层 ============
		const API = {
			async page({ offset, limit, sort, order, layers, tracks, tags, q }) {
				const p = new URLSearchParams();
				p.set('offset', String(offset || 0));
				p.set('limit', String(limit || PAGE_SIZE));
				p.set('sort', sort || 'created');
				p.set('order', order || 'desc');
				p.set('minPriority', '1');
				if (layers && layers.length) p.set('layers', layers.join(','));
				if (tracks && tracks.length) p.set('tracks', tracks.join(','));
				if (tags && tags.length) p.set('tags', tags.join(','));
				if (q) p.set('q', q);
				const r = await fetch('/api/memory/page?' + p.toString());
				if (!r.ok) throw new Error('page: ' + r.status);
				return r.json();
			},
			async stats() {
				const r = await fetch('/api/memory/stats');
				if (!r.ok) throw new Error('stats: ' + r.status);
				return r.json();
			},
			async add(content, opts) {
				const r = await fetch('/api/memory/add', {
					method: 'POST', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ content, ...(opts || {}) }),
				});
				if (!r.ok) throw new Error('add: ' + r.status);
				return r.json();
			},
			async update(id, changes) {
				const r = await fetch('/api/memory/update', {
					method: 'POST', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ id, changes }),
				});
				if (!r.ok) throw new Error('update: ' + r.status);
				return r.json();
			},
			async remove(id, hard) {
				const r = await fetch('/api/memory/remove', {
					method: 'POST', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ id, hard: !!hard }),
				});
				if (!r.ok) throw new Error('remove: ' + r.status);
				return r.json();
			},
			async batch(op, payload) {
				const r = await fetch('/api/memory/batch', {
					method: 'POST', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ op, ...payload }),
				});
				if (!r.ok) throw new Error('batch: ' + r.status);
				return r.json();
			},
		};

		// ============ 工具函数 ============
		const fmtTime = (s) => {
			if (!s) return '';
			const d = new Date(String(s).replace(' ', 'T') + 'Z');
			if (isNaN(d.getTime())) return String(s);
			const now = new Date();
			const sameDay = d.toDateString() === now.toDateString();
			if (sameDay) return d.toTimeString().slice(0, 5);
			return d.toISOString().slice(0, 10);
		};
		const truncate = (s, n) => s && s.length > n ? s.slice(0, n) + '…' : (s || '');

		// ============ 主组件 ============
		function MemoryPanel({ memoryService, reload }) {
			const [rows, setRows] = useState([]);
			const [total, setTotal] = useState(0);
			const [page, setPage] = useState(0);
			const [sort, setSort] = useState('created');
			const [order, setOrder] = useState('desc');
			const [searchInput, setSearchInput] = useState('');
			const [searchQ, setSearchQ] = useState('');
			const [layerFilter, setLayerFilter] = useState([]);
			const [trackFilter, setTrackFilter] = useState([]);
			const [tagFilter, setTagFilter] = useState([]);
			const [stats, setStats] = useState({ total: 0, byLayer: [], byTrack: [], byPriority: [], topTags: [] });
			const [loading, setLoading] = useState(true);
			const [toast, setToast] = useState(null);
			const [selected, setSelected] = useState(new Set());
			const [editingId, setEditingId] = useState(null);
			const [editContent, setEditContent] = useState('');
			const [showAdd, setShowAdd] = useState(false);
			const [newContent, setNewContent] = useState('');
			const [newLayer, setNewLayer] = useState(3);
			const [newTrack, setNewTrack] = useState('user');
			const [newPriority, setNewPriority] = useState(3);
			const [confirmDel, setConfirmDel] = useState(null);
			const [deleteConfirm, setDeleteConfirm] = useState(null); // { ids: [], hard?: boolean } | null
			const [hoverId, setHoverId] = useState(null);
			const searchTimer = useRef(null);

			const flash = useCallback((msg) => {
				setToast(msg);
				setTimeout(() => setToast(null), 2500);
			}, []);

			const loadPage = useCallback(async () => {
				try {
					setLoading(true);
					const r = await API.page({
						offset: page * PAGE_SIZE,
						limit: PAGE_SIZE,
						sort, order,
						layers: layerFilter, tracks: trackFilter, tags: tagFilter,
						q: searchQ,
					});
					setRows(r.rows || []);
					setTotal(r.total || 0);
					setSelected(new Set());
				} catch (e) {
					flash('加载失败: ' + e.message);
				} finally {
					setLoading(false);
				}
			}, [page, sort, order, layerFilter, trackFilter, tagFilter, searchQ, flash]);

			const loadStats = useCallback(async () => {
				try { setStats(await API.stats()); } catch {}
			}, []);

			const reloadAll = useCallback(async () => {
				await Promise.all([loadPage(), loadStats()]);
			}, [loadPage, loadStats]);

			useEffect(() => { reloadAll(); }, [reloadAll]);

			useEffect(() => {
				if (searchTimer.current) clearTimeout(searchTimer.current);
				searchTimer.current = setTimeout(() => {
					setSearchQ(searchInput);
					setPage(0);
				}, 300);
				return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
			}, [searchInput]);

			const onSort = (col) => {
				if (sort === col) setOrder(order === 'asc' ? 'desc' : 'asc');
				else { setSort(col); setOrder('desc'); }
				setPage(0);
			};

			const toggleFilter = (arr, setArr, val) => {
				setPage(0);
				if (arr.includes(val)) setArr(arr.filter(x => x !== val));
				else setArr([...arr, val]);
			};

			const toggleSelect = (id) => {
				const next = new Set(selected);
				if (next.has(id)) next.delete(id); else next.add(id);
				setSelected(next);
			};

			const toggleSelectAll = () => {
				if (rows.every(r => selected.has(r.id))) setSelected(new Set());
				else setSelected(new Set(rows.map(r => r.id)));
			};

			const handleAdd = async () => {
				if (!newContent.trim()) return;
				try {
					await API.add(newContent.trim(), { layer: newLayer, track: newTrack, priority: newPriority });
					setNewContent('');
					setShowAdd(false);
					flash('已添加');
					reloadAll();
				} catch (e) { flash('添加失败: ' + e.message); }
			};

			const handleEdit = async (id) => {
				if (!editContent.trim()) return;
				try {
					await API.update(id, { content: editContent.trim() });
					setEditingId(null);
					setEditContent('');
					flash('已更新');
					reloadAll();
				} catch (e) { flash('更新失败: ' + e.message); }
			};

			const handleDelete = async (ids, hard) => {
				try {
					const r = await API.batch('remove', { ids, hard: true });
					flash(`已物理删除 ${r.removed} 条`);
					reloadAll();
				} catch (e) { flash('删除失败: ' + e.message); }
			};

			const handleBatch = async (op, payload) => {
				const ids = [...selected];
				if (ids.length === 0) return;
				try {
					const r = await API.batch(op, { ids, ...payload });
					const n = r.updated ?? r.removed ?? 0;
					flash(`已处理 ${n} 条`);
					reloadAll();
				} catch (e) { flash('批量操作失败: ' + e.message); }
			};

			const handleDeleteConfirm = async (hard = true) => {
				if (!deleteConfirm) return;
				const { ids } = deleteConfirm;
				setDeleteConfirm(null);
				await handleDelete(ids, hard);
			};

			const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
			const allOnPageSelected = rows.length > 0 && rows.every(r => selected.has(r.id));
			const someOnPageSelected = rows.some(r => selected.has(r.id));

			const layerPills = useMemo(() => {
				const map = new Map(stats.byLayer.map(x => [x.layer, x.n]));
				return LAYERS.map(l => ({ ...l, count: map.get(l.id) || 0 }));
			}, [stats]);
			const trackPills = useMemo(() => stats.byTrack.map(t => ({
				name: t.track, count: t.n, color: TRACK_COLORS[t.track] || '#6b7280',
			})), [stats]);
			const tagPills = useMemo(() => stats.topTags.slice(0, 12), [stats]);

			const sortIcon = (col) => sort === col ? (order === 'asc' ? ' ▲' : ' ▼') : '';

			return react_jsx_runtime.jsxs("div", { style: S.root, children: [
				toast && react_jsx_runtime.jsx("div", { style: S.toast, children: toast }),
				deleteConfirm && react_jsx_runtime.jsx("div", { style: S.confirmMask, children: react_jsx_runtime.jsxs("div", { style: S.confirmBox, children: [
					react_jsx_runtime.jsx("div", { style: S.confirmTitle, children: "确认物理删除？" }),
					react_jsx_runtime.jsxs("div", { style: S.confirmBody, children: [
						react_jsx_runtime.jsxs("div", { children: ["将", "物理删除 ", react_jsx_runtime.jsx("b", { children: deleteConfirm.ids.length }), " 条记忆。"] }),
						react_jsx_runtime.jsx("div", { style: { color: 'var(--dsw-alias-interactive-bg-hover-danger)', fontSize: 12, marginTop: 4 }, children: "⚠ 物理删除不可恢复，连同向量索引一起清理。" }),
					] }),
					react_jsx_runtime.jsxs("div", { style: S.confirmActions, children: [
						react_jsx_runtime.jsx("button", { style: S.cancelBtn, onClick: () => setDeleteConfirm(null), children: "取消" }),
						react_jsx_runtime.jsx("button", {
							style: Object.assign({}, S.dangerBtn, { background: 'var(--dsw-alias-interactive-bg-hover-danger)' }),
							onClick: () => handleDeleteConfirm(true),
							children: "确认删除",
						}),
					] }),
				] }) }),

				react_jsx_runtime.jsxs("div", { style: S.header, children: [
					react_jsx_runtime.jsxs("div", { style: S.titleRow, children: [
						react_jsx_runtime.jsx("span", { style: S.title, children: "🧠 记忆" }),
						react_jsx_runtime.jsxs("span", { style: S.badge, children: [total, " 条 · 第 ", page + 1, " / ", totalPages, " 页"] }),
					] }),
					react_jsx_runtime.jsxs("div", { style: S.statsRow, children: [
						...layerPills.map(l => react_jsx_runtime.jsx("span", {
							style: Object.assign({}, S.pill, {
								borderColor: layerFilter.includes(l.id) ? l.color : 'var(--dsw-alias-border-l2)',
								color: layerFilter.includes(l.id) ? l.color : 'var(--dsw-alias-label-secondary)',
								background: layerFilter.includes(l.id) ? 'var(--dsw-alias-interactive-bg-active)' : 'transparent',
							}),
							onClick: () => toggleFilter(layerFilter, setLayerFilter, l.id),
							title: `点击${layerFilter.includes(l.id) ? '取消' : '添加'} L${l.id} 过滤`,
							children: [l.label, " ", l.count],
						}, l.id)),
						...trackPills.map(t => react_jsx_runtime.jsx("span", {
							style: Object.assign({}, S.pill, {
								borderColor: trackFilter.includes(t.name) ? t.color : 'var(--dsw-alias-border-l2)',
								color: trackFilter.includes(t.name) ? t.color : 'var(--dsw-alias-label-secondary)',
								background: trackFilter.includes(t.name) ? 'var(--dsw-alias-interactive-bg-active)' : 'transparent',
							}),
							onClick: () => toggleFilter(trackFilter, setTrackFilter, t.name),
							title: `点击${trackFilter.includes(t.name) ? '取消' : '添加'} track 过滤`,
							children: [t.name, " ", t.count],
						}, t.name)),
					] }),
					tagPills.length > 0 && react_jsx_runtime.jsxs("div", { style: Object.assign({}, S.statsRow, { marginTop: 4 }), children: [
						react_jsx_runtime.jsx("span", { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginRight: 4 }, children: "tags:" }),
						...tagPills.map(t => react_jsx_runtime.jsx("span", {
							style: Object.assign({}, S.pill, {
								borderColor: 'var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-secondary)', background: tagFilter.includes(t.tag) ? 'var(--dsw-alias-interactive-bg-active)' : 'transparent',
							}),
							onClick: () => toggleFilter(tagFilter, setTagFilter, t.tag),
							children: ["#", t.tag, " ", t.count],
						}, t.tag)),
					] }),
				] }),

				react_jsx_runtime.jsxs("div", { style: S.toolbar, children: [
					react_jsx_runtime.jsx("input", {
						style: S.searchInput, placeholder: "搜索关键词...", value: searchInput,
						onChange: e => setSearchInput(e.target.value),
					}),
					(layerFilter.length > 0 || trackFilter.length > 0 || tagFilter.length > 0 || searchQ) && react_jsx_runtime.jsx("button", {
						style: S.iconBtn,
						onClick: () => { setLayerFilter([]); setTrackFilter([]); setTagFilter([]); setSearchInput(''); setPage(0); },
						children: "清空过滤",
					}),
					react_jsx_runtime.jsx("button", {
						style: S.addBtn,
						onClick: () => setShowAdd(!showAdd),
						children: showAdd ? "✕ 收起" : "+ 新增",
					}),
				] }),

				showAdd && react_jsx_runtime.jsxs("div", { style: S.formCard, children: [
					react_jsx_runtime.jsx("textarea", {
						style: S.textarea, placeholder: "输入记忆内容...", value: newContent,
						onChange: e => setNewContent(e.target.value), rows: 3,
					}),
					react_jsx_runtime.jsxs("div", { style: S.formRow, children: [
						react_jsx_runtime.jsxs("label", { style: S.formLabel, children: [
							"layer:", react_jsx_runtime.jsx("select", {
								style: S.select, value: newLayer,
								onChange: e => setNewLayer(Number(e.target.value)),
								children: LAYERS.map(l => react_jsx_runtime.jsx("option", { value: l.id, children: l.label }, l.id)),
							}),
						] }),
						react_jsx_runtime.jsxs("label", { style: S.formLabel, children: [
							"track:", react_jsx_runtime.jsx("select", {
								style: S.select, value: newTrack,
								onChange: e => setNewTrack(e.target.value),
								children: TRACKS.map(t => react_jsx_runtime.jsx("option", { value: t, children: t }, t)),
							}),
						] }),
						react_jsx_runtime.jsxs("label", { style: S.formLabel, children: [
							"p:", react_jsx_runtime.jsx("select", {
								style: S.select, value: newPriority,
								onChange: e => setNewPriority(Number(e.target.value)),
								children: [1, 2, 3, 4, 5].map(p => react_jsx_runtime.jsx("option", { value: p, children: String(p) }, p)),
							}),
						] }),
						react_jsx_runtime.jsx("button", { style: S.saveBtn, onClick: handleAdd, children: "保存" }),
					] }),
				] }),

				selected.size > 0 && react_jsx_runtime.jsxs("div", { style: S.batchBar, children: [
					react_jsx_runtime.jsx("span", { style: { fontWeight: 600 }, children: `已选 ${selected.size} 条` }),
					react_jsx_runtime.jsx("span", { style: { color: '#9ca3af', fontSize: 12, marginRight: 8 }, children: "→" }),
					react_jsx_runtime.jsx("button", { style: S.miniBtn, onClick: () => handleBatch('update', { changes: { layer: 4 } }), children: "→ L4" }),
					react_jsx_runtime.jsx("button", { style: S.miniBtn, onClick: () => handleBatch('update', { changes: { layer: 3 } }), children: "→ L3" }),
					react_jsx_runtime.jsx("button", { style: S.miniBtn, onClick: () => handleBatch('update', { changes: { track: 'user' } }), children: "→ user" }),
					react_jsx_runtime.jsx("button", { style: S.miniBtn, onClick: () => handleBatch('update', { changes: { track: 'project' } }), children: "→ project" }),
					react_jsx_runtime.jsx("button", { style: S.miniBtn, onClick: () => handleBatch('update', { changes: { priority: 5 } }), children: "→ p5" }),
					react_jsx_runtime.jsx("button", { style: S.miniBtn, onClick: () => handleBatch('update', { changes: { priority: 1 } }), children: "→ p1" }),
					react_jsx_runtime.jsx("button", { style: S.miniBtn, onClick: () => {
						const t = prompt('要添加的 tag（不含 #）：');
						if (t?.trim()) handleBatch('tag', { add: [t.trim()] });
					}, children: "+ tag" }),
					react_jsx_runtime.jsx("button", { style: Object.assign({}, S.miniBtn, { color: '#fff', background: 'var(--dsw-alias-interactive-bg-hover-danger)', borderColor: 'var(--dsw-alias-interactive-bg-hover-danger)' }), onClick: () => setDeleteConfirm({ ids: [...selected] }), children: "删除" }),
					react_jsx_runtime.jsx("button", { style: Object.assign({}, S.miniBtn, { marginLeft: 'auto' }), onClick: () => setSelected(new Set()), children: "清空选择" }),
				] }),

				react_jsx_runtime.jsx("div", { style: S.tableWrap, children: loading
					? react_jsx_runtime.jsx("div", { style: S.empty, children: "加载中..." })
					: rows.length === 0
						? react_jsx_runtime.jsx("div", { style: S.empty, children: "暂无记忆" })
						: react_jsx_runtime.jsx("table", { style: S.table, children: [
							react_jsx_runtime.jsx("colgroup", { children: [
								react_jsx_runtime.jsx("col", { style: { width: 28 } }),
								react_jsx_runtime.jsx("col", { style: { width: 44 } }),
								react_jsx_runtime.jsx("col", { style: { width: 28 } }),
								react_jsx_runtime.jsx("col", { style: { width: 64 } }),
								react_jsx_runtime.jsx("col", { style: { width: 28 } }),
								react_jsx_runtime.jsx("col", { style: { width: 100 } }),
								react_jsx_runtime.jsx("col", { style: { width: 'auto' } }),
								react_jsx_runtime.jsx("col", { style: { width: 82 } }),
								react_jsx_runtime.jsx("col", { style: { width: 86 } }),
							] }),
							react_jsx_runtime.jsx("thead", { children: react_jsx_runtime.jsxs("tr", { style: S.theadTr, children: [
								react_jsx_runtime.jsx("th", { style: Object.assign({}, S.th, { width: 28 }), children: react_jsx_runtime.jsx("input", {
									type: "checkbox", checked: allOnPageSelected,
									ref: el => { if (el) el.indeterminate = !allOnPageSelected && someOnPageSelected; },
									onChange: toggleSelectAll,
								}) }),
								react_jsx_runtime.jsx("th", { style: Object.assign({}, S.th, S.thSort, { width: 44 }), onClick: () => onSort('id'), children: ["id", sortIcon('id')] }),
								react_jsx_runtime.jsx("th", { style: Object.assign({}, S.th, S.thSort, { width: 28 }), onClick: () => onSort('layer'), children: ["L", sortIcon('layer')] }),
								react_jsx_runtime.jsx("th", { style: Object.assign({}, S.th, S.thSort, { width: 64 }), onClick: () => onSort('track'), children: ["track", sortIcon('track')] }),
								react_jsx_runtime.jsx("th", { style: Object.assign({}, S.th, S.thSort, { width: 28 }), onClick: () => onSort('priority'), children: ["p", sortIcon('priority')] }),
								react_jsx_runtime.jsx("th", { style: Object.assign({}, S.th, { width: 100 }), children: "tags" }),
								react_jsx_runtime.jsx("th", { style: Object.assign({}, S.th, S.thSort), onClick: () => onSort('content'), children: ["content", sortIcon('content')] }),
								react_jsx_runtime.jsx("th", { style: Object.assign({}, S.th, S.thSort, { width: 82 }), onClick: () => onSort('created'), children: ["created", sortIcon('created')] }),
								react_jsx_runtime.jsx("th", { style: Object.assign({}, S.th, { width: 86 }), children: "操作" }),
							] }) }),
							react_jsx_runtime.jsx("tbody", { children: rows.map(m => {
								const lc = (LAYERS.find(l => l.id === m.layer) || LAYERS[3]).color;
								const tc = TRACK_COLORS[m.track] || '#6b7280';
								const isEditing = editingId === m.id;
								const isSelected = selected.has(m.id);
								const isHover = hoverId === m.id;
								const trStyle = isEditing ? S.trEditing : (isSelected ? S.trSelected : (isHover ? S.trHover : S.tr));
								return react_jsx_runtime.jsxs("tr", {
									style: trStyle,
									onMouseEnter: () => setHoverId(m.id),
									onMouseLeave: () => setHoverId(prev => prev === m.id ? null : prev),
									children: [
										react_jsx_runtime.jsx("td", { style: S.td, children: react_jsx_runtime.jsx("input", {
											type: "checkbox", checked: selected.has(m.id),
											onChange: () => toggleSelect(m.id),
										}) }),
										react_jsx_runtime.jsx("td", { style: Object.assign({}, S.tdMono, S.td), children: m.id }),
										react_jsx_runtime.jsx("td", { style: Object.assign({}, S.td, { color: lc, fontWeight: 600 }), children: m.layer }),
										react_jsx_runtime.jsx("td", { style: Object.assign({}, S.td, { color: tc, fontWeight: 600 }), children: m.track }),
										react_jsx_runtime.jsx("td", { style: Object.assign({}, S.tdMono, S.td), children: m.priority }),
										react_jsx_runtime.jsx("td", { style: S.td, children: (m.tags || []).slice(0, 3).map(t => react_jsx_runtime.jsx("span", {
											style: S.tagChip, children: ["#", t],
										}, t)) }),
										react_jsx_runtime.jsx("td", { style: S.td, children:
											isEditing
												? react_jsx_runtime.jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: 4 }, children: [
													react_jsx_runtime.jsx("textarea", {
														style: S.editArea, value: editContent,
														onChange: e => setEditContent(e.target.value), rows: 2,
													}),
													react_jsx_runtime.jsxs("div", { style: { display: 'flex', gap: 4 }, children: [
														react_jsx_runtime.jsx("button", { style: S.saveBtn, onClick: () => handleEdit(m.id), children: "✓" }),
														react_jsx_runtime.jsx("button", { style: S.cancelBtn, onClick: () => { setEditingId(null); setEditContent(''); }, children: "✕" }),
													] }),
												] })
												: react_jsx_runtime.jsx("span", { style: S.contentCell, title: m.content, children: truncate(m.content, 240) })
										}),
										react_jsx_runtime.jsx("td", { style: Object.assign({}, S.tdMono, S.td), title: m.created, children: fmtTime(m.created) }),
										react_jsx_runtime.jsx("td", { style: S.td, children:
											react_jsx_runtime.jsxs("div", { style: S.rowBtnGroup, children: [
												!isEditing && react_jsx_runtime.jsx("button", { style: S.rowBtn, onClick: () => { setEditingId(m.id); setEditContent(m.content); }, title: "编辑", children: "✎" }),
												!isEditing && react_jsx_runtime.jsx("button", { style: Object.assign({}, S.rowBtn, { color: '#dc2626' }), onClick: () => setDeleteConfirm({ ids: [m.id] }), title: "删除", children: "🗑" }),
											] })
										}),
									],
								}, m.id);
							}) }),
						] })
				}),

				totalPages > 1 && react_jsx_runtime.jsxs("div", { style: S.pager, children: [
					react_jsx_runtime.jsx("button", { style: S.pageBtn, disabled: page === 0, onClick: () => setPage(0), children: "« 首页" }),
					react_jsx_runtime.jsx("button", { style: S.pageBtn, disabled: page === 0, onClick: () => setPage(p => Math.max(0, p - 1)), children: "‹ 上一页" }),
					react_jsx_runtime.jsxs("span", { style: { padding: '0 8px' }, children: ["第 ", react_jsx_runtime.jsx("input", {
						style: S.pageInput, type: "number", min: 1, max: totalPages, value: page + 1,
						onChange: e => {
							const v = parseInt(e.target.value) || 1;
							setPage(Math.max(0, Math.min(totalPages - 1, v - 1)));
						},
					}), " / ", totalPages, " 页"] }),
					react_jsx_runtime.jsx("button", { style: S.pageBtn, disabled: page >= totalPages - 1, onClick: () => setPage(p => Math.min(totalPages - 1, p + 1)), children: "下一页 ›" }),
					react_jsx_runtime.jsx("button", { style: S.pageBtn, disabled: page >= totalPages - 1, onClick: () => setPage(totalPages - 1), children: "尾页 »" }),
					react_jsx_runtime.jsxs("span", { style: { marginLeft: 'auto', fontSize: 12, color: '#6b7280' }, children: ["共 ", total, " 条，每页 ", PAGE_SIZE] }),
				] }),
			] });
		}

		// ============ 样式 ============
		const S = {
			root: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)' },
			toast: { position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-base)', padding: '8px 20px', borderRadius: 8, fontSize: 13, zIndex: 1000, boxShadow: '0 4px 12px rgba(0,0,0,0.2)' },
			confirmMask: { position: 'fixed', inset: 0, background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.4))', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 },
			confirmBox: { background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, padding: 20, minWidth: 320, maxWidth: 480, boxShadow: '0 8px 32px rgba(0,0,0,0.3)' },
			confirmTitle: { fontSize: 15, fontWeight: 600, marginBottom: 12 },
			confirmBody: { fontSize: 13, lineHeight: 1.6, marginBottom: 16 },
			confirmActions: { display: 'flex', gap: 8, justifyContent: 'flex-end' },
			header: { padding: '12px 16px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)', flex: 'none' },
			titleRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
			title: { fontSize: 16, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
			badge: { background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-secondary)', borderRadius: 12, padding: '2px 8px', fontSize: 12, fontWeight: 500 },
			statsRow: { display: 'flex', flexWrap: 'wrap', gap: 6 },
			pill: { fontSize: 11, padding: '2px 10px', borderRadius: 12, cursor: 'pointer', border: '1px solid', fontWeight: 500, userSelect: 'none' },
			toolbar: { display: 'flex', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1)', flex: 'none', alignItems: 'center' },
			searchInput: { flex: 1, height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', fontSize: 13, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', boxSizing: 'border-box' },
			iconBtn: { height: 32, padding: '0 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', cursor: 'pointer', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box' },
			addBtn: { height: 32, padding: '0 14px', borderRadius: 8, border: 'none', fontSize: 13, cursor: 'pointer', color: 'var(--dsw-alias-label-primary-inverted)', fontWeight: 500, background: 'var(--dsw-alias-button-primary-fill)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box' },
			formCard: { padding: '12px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1)', flex: 'none', background: 'var(--dsw-alias-bg-layer-1)' },
			formRow: { display: 'flex', gap: 12, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' },
			formLabel: { display: 'flex', gap: 4, alignItems: 'center', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
			textarea: { width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', fontSize: 13, resize: 'vertical', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit', boxSizing: 'border-box' },
			editArea: { width: '100%', padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)', fontSize: 12, resize: 'vertical', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit', boxSizing: 'border-box' },
			select: { padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)', fontSize: 12, background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)' },
			saveBtn: { padding: '4px 12px', borderRadius: 6, border: 'none', background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-inverted)', fontSize: 12, cursor: 'pointer', fontWeight: 500 },
			cancelBtn: { padding: '4px 12px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontSize: 12, cursor: 'pointer' },
			dangerBtn: { padding: '6px 14px', borderRadius: 6, border: 'none', color: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 500, background: 'var(--dsw-alias-interactive-bg-hover-danger)' },
			batchBar: { display: 'flex', gap: 6, padding: '8px 16px', background: 'var(--dsw-alias-bg-layer-1)', borderBottom: '1px solid var(--dsw-alias-border-l1)', flex: 'none', alignItems: 'center', flexWrap: 'wrap' },
			miniBtn: { padding: '3px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', fontSize: 11, cursor: 'pointer', color: 'var(--dsw-alias-label-primary)' },
			tableWrap: { flex: 1, overflow: 'auto', padding: '0' },
			empty: { textAlign: 'center', color: '#9ca3af', fontSize: 13, padding: '40px 0' },
			table: { width: '100%', borderCollapse: 'collapse', fontSize: 12, lineHeight: 1.4, tableLayout: 'fixed' },
			theadTr: { position: 'sticky', top: 0, background: 'var(--dsw-alias-bg-layer-1)', zIndex: 1 },
			th: { textAlign: 'left', padding: '5px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', fontSize: 11, letterSpacing: 0.2, textTransform: 'uppercase', background: 'var(--dsw-alias-bg-layer-1)' },
			thSort: { cursor: 'pointer', userSelect: 'none' },
			tr: { borderBottom: '1px solid var(--dsw-alias-border-l1)', height: 32 },
			trHover: { background: 'var(--dsw-alias-interactive-bg-hover)', borderBottom: '1px solid var(--dsw-alias-border-l1)', height: 32 },
			trSelected: { background: 'var(--dsw-alias-interactive-bg-active)', borderBottom: '1px solid var(--dsw-alias-border-l1)', height: 32 },
			trEditing: { background: 'var(--dsw-alias-interactive-bg-active)' },
			td: { padding: '3px 8px', verticalAlign: 'middle', color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
			tdMono: { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
			contentCell: { display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' },
			tagChip: { display: 'inline-block', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-brand-primary)', padding: '0 5px', borderRadius: 6, fontSize: 10, marginRight: 2, lineHeight: '16px' },
			rowBtn: { padding: '0 6px', borderRadius: 3, border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '20px', height: 22 },
			rowBtnGroup: { display: 'flex', gap: 3, alignItems: 'center', height: 22 },
			pager: { display: 'flex', gap: 4, padding: '8px 12px', borderTop: '1px solid var(--dsw-alias-border-l1)', flex: 'none', alignItems: 'center', fontSize: 12, background: 'var(--dsw-alias-bg-base)' },
			pageBtn: { padding: '3px 10px', borderRadius: 5, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', fontSize: 11, cursor: 'pointer' },
			pageInput: { width: 48, padding: '2px 4px', borderRadius: 3, border: '1px solid var(--dsw-alias-border-l2)', textAlign: 'center', fontSize: 11 },
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
