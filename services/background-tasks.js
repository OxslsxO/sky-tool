let tasks = [];
let listeners = [];

function generateId() {
  return "bt_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function addTask(title, toolId) {
  const task = {
    id: generateId(),
    title: title || "处理中",
    toolId: toolId || "",
    progress: 0,
    status: "",
    startedAt: Date.now(),
  };
  tasks.push(task);
  notifyListeners();
  return task.id;
}

function updateTask(taskId, progress, status) {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return;
  task.progress = Math.min(100, Math.max(0, Math.round(progress || 0)));
  if (status !== undefined && status !== null) {
    task.status = status;
  }
  notifyListeners();
}

function removeTask(taskId) {
  tasks = tasks.filter((t) => t.id !== taskId);
  notifyListeners();
}

function getTasks() {
  return tasks.slice();
}

function getTaskCount() {
  return tasks.length;
}

function addListener(fn) {
  if (typeof fn === "function" && !listeners.includes(fn)) {
    listeners.push(fn);
  }
}

function removeListener(fn) {
  listeners = listeners.filter((l) => l !== fn);
}

function notifyListeners() {
  const snapshot = getTasks();
  listeners.forEach((fn) => {
    try {
      fn(snapshot);
    } catch (e) {
      // ignore
    }
  });
}

module.exports = {
  addTask,
  updateTask,
  removeTask,
  getTasks,
  getTaskCount,
  addListener,
  removeListener,
};
