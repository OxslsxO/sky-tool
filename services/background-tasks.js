let tasks = [];
let listeners = [];

function generateId() {
  return "bt_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function addTask(title, toolId, storeTaskId) {
  const task = {
    id: generateId(),
    title: title || "处理中",
    toolId: toolId || "",
    storeTaskId: storeTaskId || "",
    progress: 0,
    completed: false,
    status: "",
    startedAt: Date.now(),
  };
  tasks.push(task);
  notifyListeners();
  return task.id;
}

function updateTask(bgTaskId, progress, status) {
  const task = tasks.find((t) => t.id === bgTaskId);
  if (!task) return;
  task.progress = Math.min(100, Math.max(0, Math.round(progress || 0)));
  if (status !== undefined && status !== null) {
    task.status = status;
  }
  if (task.progress >= 100) {
    task.completed = true;
  }
  notifyListeners();
}

function completeTask(bgTaskId, storeTaskId) {
  const task = tasks.find((t) => t.id === bgTaskId);
  if (!task) return;
  task.progress = 100;
  task.completed = true;
  task.status = "已完成";
  if (storeTaskId) {
    task.storeTaskId = storeTaskId;
  }
  notifyListeners();
}

function removeTask(bgTaskId) {
  tasks = tasks.filter((t) => t.id !== bgTaskId);
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
  completeTask,
  removeTask,
  getTasks,
  getTaskCount,
  addListener,
  removeListener,
};
