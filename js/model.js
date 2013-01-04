/* This file is part of Tryton.  The COPYRIGHT file at the top level of
   this repository contains the full copyright notices and license terms. */
(function() {
    'use strict';

    Sao.Model = Sao.class_(Object, {
        init: function(name, attributes) {
            attributes = attributes || {};
            this.name = name;
            this.session = Sao.Session.current_session;
            this.fields = {};
        },
        add_fields: function(descriptions) {
            for (var name in descriptions) {
                if (descriptions.hasOwnProperty(name) &&
                    (!(name in this.fields))) {
                        var desc = descriptions[name];
                        var Field = Sao.field.get(desc.type);
                        this.fields[name] = new Field(desc);
                    }
            }
        },
        execute: function(method, params, context) {
            var args = {
                'method': 'model.' + this.name + '.' + method,
                'params': params.concat(context)
            };
            return Sao.rpc(args, this.session);
        },
        find: function(condition, offset, limit, order, context) {
            if (!offset) offset = 0;
            var self = this;
            var prm = this.execute('search',
                    [condition, offset, limit, order], context);
            var instanciate = function(ids) {
                return Sao.Group(self, context, ids.map(function(id) {
                    return new Sao.Record(self, id);
                }));
            };
            return prm.pipe(instanciate);
        },
        delete_: function(records, context) {
            return this.execute('delete', [records.map(function(record) {
                return record.id;
            })], context);
        }
    });

    Sao.Group = function(model, context, array) {
        array.prm = jQuery.when();
        array.model = model;
        array.context = context;
        array.parent = undefined;
        array.parent_name = '';
        array.child_name = '';
        array.parent_datetime_field = undefined;
        array.record_removed = [];
        array.record_deleted = [];
        array.forEach(function(e, i, a) {
            e.group = a;
        });
        array.load = function(ids) {
            var new_records = [];
            var i, len;
            for (i = 0, len = ids.length; i < len; i++) {
                var id = ids[i];
                var new_record = this.get(id);
                if (!new_record) {
                    new_record = new Sao.Record(this.model, id);
                    new_record.group = this;
                    this.push(new_record);
                }
                new_records.push(new_record);
            }
            // Remove previously removed or deleted records
            var record_removed = [];
            var record;
            for (i = 0, len = this.record_removed.length; i < len; i++) {
                record = this.record_removed[i];
                if (ids.indexOf(record.id) < 0) {
                    record_removed.push(record);
                }
            }
            this.record_removed = record_removed;
            var record_deleted = [];
            for (i = 0, len = this.record_deleted.length; i < len; i++) {
                record = this.record_deleted[i];
                if (ids.indexOf(record.id) < 0) {
                    record_deleted.push(record);
                }
            }
            this.record_deleted = record_deleted;
        };
        array.get = function(id) {
            // TODO optimize
            for (var i = 0, len = this.length; i < len; i++) {
                var record = this[i];
                if (record.id == id) {
                    return record;
                }
            }
        };
        array.new_ = function(default_, id) {
            var record = Sao.Record(this.name, id);
            record.model = this.model;
            record.group = this;
            if (default_) {
                record.default_get();
            }
            return record;
        };
        array.add = function(record, position) {
            if (position === undefined) {
                position = -1;
            }
            if (record.group != this) {
                record.group = this;
            }
            this.splice(position, 0, record);
            for (var record_rm in this.record_removed) {
                if (record_rm.id == record.id) {
                    this.record_removed.splice(
                            this.record_removed.indexOf(record_rm), 1);
                }
            }
            for (var record_del in this.record_deleted) {
                if (record_del.id == record.id) {
                    this.record_deleted.splice(
                            this.record_deleted.indexOf(record_del), 1);
                }
            }
            record.changed.id = true;
            return record;
        };
        return array;
    };

    Sao.Record = Sao.class_(Object, {
        id_counter: -1,
        init: function(model, id) {
            this.model = model;
            this.group = Sao.Group(model, {}, []);
            this.id = id || Sao.Record.prototype.id_counter--;
            this._values = {};
            this._changed = {};
            this._loaded = {};
            this.fields = {};
            this._timestamp = null;
        },
        has_changed: function() {
            return !jQuery.isEmptyObject(this._changed);
        },
        save: function() {
            var context = this.get_context();
            var prm, values;
            if (this.id < 0) {
                values = this.get();
                prm = this.model.execute('create', [values], context);
                var created = function(id) {
                    this.id = id;
                };
                prm.done(created.bind(this));
            } else {
                values = this.get(true);
                if (!jQuery.isEmptyObject(values)) {
                    prm = this.model.execute('write', [this.id, values],
                            context);
                }
            }
            prm.done(this.reload.bind(this));
            return prm;
        },
        reload: function() {
            this._values = {};
            this._loaded = {};
            this._changed = {};
        },
        load: function(name) {
            var self = this;
            var fname;
            if ((this.id < 0) || (name in this._loaded)) {
                return jQuery.when();
            }
            if (this.group.prm.state() == 'pending') {
                var load = function() {
                    return this.load(name);
                };
                return this.group.prm.pipe(load.bind(this));
            }
            var id2record = {};
            id2record[this.id] = this;
            var loading;
            if (name == '*') {
                loading = 'eager';
                for (fname in this.model.fields) {
                    if (!this.model.fields.hasOwnProperty(fname)) {
                        continue;
                    }
                    var field_loading = (
                            this.model.fields[fname].description.loading ||
                            'eager');
                    if (field_loading != 'eager') {
                        loading = 'lazy';
                        break;
                    }
                }
            } else {
                loading = (this.model.fields[name].description.loading ||
                        'eager');
            }
            if ((this.group.indexOf(this) >= 0) && (loading == 'eager')) {
                var idx = this.group.indexOf(this);
                var length = this.group.length;
                var n = 1;
                while (Object.keys(id2record).length &&
                        ((idx - n >= 0) || (idx + n < length)) &&
                        n < 100) {
                            var record;
                            if (idx - n >= 0) {
                                record = this.group[idx - n];
                                if (!(name in record._loaded) &&
                                        (record.id >= 0)) {
                                    id2record[record.id] = record;
                                }
                            }
                            if (idx + n < length) {
                                record = this.group[idx + n];
                                if (!(name in record._loaded) &&
                                        (record.id >= 0)) {
                                    id2record[record.id] = record;
                                }
                            }
                            n++;
                        }
            }
            var context = this.get_context();
            var fnames = [];
            if (loading == 'eager') {
                for (fname in this.model.fields) {
                    if (!this.model.fields.hasOwnProperty(fname)) {
                        continue;
                    }
                    if ((this.model.fields[fname].description.loading ||
                                'eager') == 'eager') {
                        fnames.push(fname);
                    }
                }
            } else {
                fnames = Object.keys(this.model.fields);
            }
            fnames = fnames.filter(function(e, i, a) {
                return !(e in self._loaded);
            });
            // TODO add rec_name
            if (!('rec_name' in fnames)) {
                fnames.push('rec_name');
            }
            fnames.push('_timestamp');
            // TODO size of binary
            var prm = this.model.execute('read', [Object.keys(id2record),
                    fnames], context);
            var succeed = function(values) {
                var id2value = {};
                values.forEach(function(e, i, a) {
                    id2value[e.id] = e;
                });
                for (var id in id2record) {
                    if (!id2record.hasOwnProperty(id)) {
                        continue;
                    }
                    record = id2record[id];
                    // TODO exception
                    var value = id2value[id];
                    if (record && value) {
                        record.set(value);
                    }
                }
            };
            var failed = function() {
                // TODO  call succeed
            };
            this.group.prm = prm.then(succeed, failed);
            return this.group.prm;
        },
        set: function(values) {
            for (var name in values) {
                if (!values.hasOwnProperty(name)) {
                    continue;
                }
                var value = values[name];
                if (name == '_timestamp') {
                    this._timestamp = value;
                    continue;
                }
                if (!(name in this.model.fields)) {
                    if (name == 'rec_name') {
                        this._values[name] = value;
                    }
                    continue;
                }
                // TODO delay O2M
                // TODO Manage rec_name on M2O and Reference
                this.model.fields[name].set(this, value);
                this._loaded[name] = true;
            }
        },
        get: function() {
            var value = {};
            for (var name in this.model.fields) {
                if (!this.model.fields.hasOwnProperty(name)) {
                    continue;
                }
                var field = this.model.fields[name];
                if (field.description.readonly) {
                    continue;
                }
                if ((this._changed[name] === undefined) && this.id >= 0) {
                    continue;
                }
                value[name] = field.get(this);
            }
            return value;
        },
        get_context: function() {
            return this.group.context;
        },
        field_get: function(name) {
            return this.model.fields[name].get(this);
        },
        field_set: function(name, value) {
            this.model.fields[name].set(this, value);
        },
        field_get_client: function(name) {
            return this.model.fields[name].get_client(this);
        },
        field_set_client: function(name, value) {
            this.model.fields[name].set_client(this, value);
        },
        default_get: function() {
            var prm;
            if (!jQuery.isEmptyObject(this.model.fields)) {
                prm = this.model.execute('default_get',
                        [Object.keys(this.model.fields)], this.get_context());
                var force_parent = function(values) {
                    // TODO
                    return values;
                };
                prm = prm.pipe(force_parent).done(this.set_default.bind(this));
            } else {
                prm = jQuery.when();
            }
            // TODO autocomplete
            return prm;
        },
        set_default: function(values) {
            for (var fname in values) {
                if (!values.hasOwnProperty(fname)) {
                    continue;
                }
                var value = values[fname];
                if (!(fname in this.model.fields)) {
                    continue;
                }
                // TODO rec_name
                this.model.fields[fname].set_default(this, value);
                this._loaded[fname] = true;
            }
            // TODO validate
        }
    });


    Sao.field = {};

    Sao.field.get = function(type) {
        switch (type) {
            case 'char':
                return Sao.field.Char;
            case 'selection':
                return Sao.field.Selection;
            case 'datetime':
                return Sao.field.DateTime;
            case 'date':
                return Sao.field.Date;
            case 'time':
                return Sao.field.Time;
            case 'float':
                return Sao.field.Float;
            case 'numeric':
                return Sao.field.Numeric;
            case 'integer':
                return Sao.field.Integer;
            case 'boolean':
                return Sao.field.Boolean;
            case 'many2one':
                return Sao.field.Many2One;
            case 'one2one':
                return Sao.field.One2One;
            case 'one2many':
                return Sao.field.One2Many;
            case 'many2many':
                return Sao.field.Many2Many;
            default:
                return Sao.field.Char;
        }
    };

    Sao.field.Field = Sao.class_(Object, {
        _default: null,
        init: function(description) {
            this.description = description;
            this.name = description.name;
        },
        set: function(record, value) {
            record._values[this.name] = value;
        },
        get: function(record) {
            return record._values[this.name] || this._default;
        },
        set_client: function(record, value) {
            var previous_value = this.get(record);
            this.set(record, value);
            if (previous_value != this.get(record)) {
                record._changed[this.name] = true;
                this.changed(record);
            }
        },
        get_client: function(record) {
            return this.get(record);
        },
        set_default: function(record, value) {
            record._values[this.name] = value;
            record._changed[this.name] = true;
        },
        changed: function(record) {
            // TODO
        },
        get_context: function(record) {
            var context = jQuery.extend({}, record.get_context());
            if (record.parent) {
                jQuery.extend(context, record.parent.get_context());
            }
            // TODO eval context attribute
            return context;
        }
    });

    Sao.field.Char = Sao.class_(Sao.field.Field, {
        _default: ''
    });

    Sao.field.Selection = Sao.class_(Sao.field.Field, {
        _default: null,
        get_client: function(record) {
            return record._values[this.name];
        }
    });

    Sao.field.DateTime = Sao.class_(Sao.field.Field, {
        _default: null
    });

    Sao.field.Date = Sao.class_(Sao.field.Field, {
        _default: null
    });

    Sao.field.Time = Sao.class_(Sao.field.Field, {
    });

    Sao.field.Number = Sao.class_(Sao.field.Field, {
        _default: null,
        get: function(record) {
            if (record._values[this.name] === undefined) {
                return this._default;
            } else {
                return record._values[this.name];
            }
        },
        digits: function(record) {
            var default_ = [16, 2];
            // TODO
            return default_;
        }
    });

    Sao.field.Float = Sao.class_(Sao.field.Number, {
        set_client: function(record, value) {
            if (typeof value == 'string') {
                value = Number(value); // without new for type conversion
                if (isNaN(value)) {
                    value = this._default;
                }
            }
            Sao.field.Float._super.set_client.call(this, record, value);
        },
        get_client: function(record) {
            var value = record._values[this.name];
            if (value !== undefined) {
                var digits = this.digits(record);
                return value.toFixed(digits[1]);
            } else {
                return '';
            }
        }
    });

    Sao.field.Numeric = Sao.class_(Sao.field.Number, {
        set_client: function(record, value) {
            if (typeof value == 'string') {
                value = new Number(value); // with new to get an instance
                if (isNaN(value.valueOf())) {
                    value = this._default;
                }
            }
            Sao.field.Float._super.set_client.call(this, record, value);
        },
        get_client: function(record) {
            var value = record._values[this.name];
            if (value !== undefined) {
                var digits = this.digits(record);
                return value.toFixed(digits[1]);
            } else {
                return '';
            }
        }
    });

    Sao.field.Integer = Sao.class_(Sao.field.Number, {
        set_client: function(record, value) {
            if (typeof value == 'string') {
                value = parseInt(value, 10);
                if (isNaN(value)) {
                    value = this._default;
                }
            }
            Sao.field.Integer._super.set_client.call(this, record, value);
        },
        get_client: function(record) {
            var value = record._values[this.name];
            if (value !== undefined) {
                return '' + value;
            } else {
                return '';
            }
        },
        digits: function(record) {
            return [16, 0];
        }
    });

    Sao.field.Boolean = Sao.class_(Sao.field.Field, {
        _default: false,
        set_client: function(record, value) {
            value = Boolean(value);
            Sao.field.Boolean._super.set_client.call(this, record, value);
        },
        get: function(record) {
            return Boolean(record._values[this.name]);
        },
        get_client: function(record) {
            return Boolean(record._values[this.name]);
        }
    });

    Sao.field.Many2One = Sao.class_(Sao.field.Field, {
        _default: null,
        get: function(record) {
            var value = record._values[this.name];
            // TODO force parent
            return value;
        },
        get_client: function(record) {
            var rec_name = record._values[this.name + '.rec_name'];
            if (rec_name === undefined) {
                this.set(record, this.get(record));
                rec_name = record._values[this.name + '.rec_name'] || '';
            }
            return rec_name;
        },
        set: function(record, value) {
            var rec_name = record._values[this.name + '.rec_name'] || '';
            // TODO force parent
            var store_rec_name = function(rec_name) {
            };
            if (!rec_name && (value >= 0) && (value !== null)) {
                var prm = record.model.execute('read', [[value], ['rec_name']],
                    record.get_context());
                prm.done(store_rec_name.bind(this));
            } else {
                store_rec_name(rec_name);
            }
            record._values[this.name] = value;
            // TODO force parent
        },
        set_client: function(record, value) {
            var rec_name;
            if (value instanceof Array) {
                rec_name = value[1];
                value = value[0];
            } else {
                if (value == this.get(record)) {
                    rec_name = record._values[this.name + '.rec_name'] || '';
                } else {
                    rec_name = '';
                }
            }
            record._values[this.name + '.rec_name'] = rec_name;
            Sao.field.Many2One._super.set_client.call(this, record, value);
        }
    });

    Sao.field.One2One = Sao.class_(Sao.field.Many2One, {
    });

    Sao.field.One2Many = Sao.class_(Sao.field.Field, {
        init: function(description) {
            Sao.field.One2Many._super.init.call(this, description);
            this.context = {};
        },
        _default: null,
        set: function(record, value) {
            var group = record._values[this.name];
            var fields = {};
            if (group !== undefined) {
                fields = jQuery.extend({}, group.model.fields);
                // TODO destroy and unconnect
            } else if (record.model.name == this.description.relation) {
                fields = record.model.fields;
            }
            group = Sao.Group(new Sao.Model(this.description.relation),
                this.context, []);
            group.parent = record;
            group.parent_name = this.description.relation_field;
            group.child_name = this.name;
            group.model.fields = fields;
            record._values[this.name] = group;
            group.load(value);
        },
        get: function(record) {
            var group = record._values[this.name];
            if (group === undefined) {
                return [];
            }
            var record_removed = group.record_removed;
            var record_deleted = group.record_deleted;
            var result = [['add', []]];
            var parent_name = this.description.relation_field || '';
            for (var i = 0, len = group.length; i < len; i++) {
                var record2 = group[i];
                if ((record_removed.indexOf(record2) >= 0) ||
                    (record_deleted.indexOf(record2) >= 0)) {
                    continue;
                }
                var values;
                if (record2.id >= 0) {
                    values = record2.get();
                    delete values[parent_name];
                    if (record2.has_changed() &&
                            !jQuery.isEmptyObject(values)) {
                        result.push(['write', [record2.id], values]);
                    }
                    result[0][1].push(record2.id);
                } else {
                    values = record2.get();
                    delete values[parent_name];
                    result.push(['create', values]);
                }
            }
            if (jQuery.isEmptyObject(result[0][1])) {
                result.shift();
            }
            if (!jQuery.isEmptyObject(record_removed)) {
                result.push(['unlink', record_removed.map(function(r) {
                    return r.id;
                })]);
            }
            if (!jQuery.isEmptyObject(record_deleted)) {
                result.push(['delete', record_deleted.map(function(r) {
                    return r.id;
                })]);
            }
            return result;
        },
        set_client: function(record, value) {
        },
        get_client: function(record) {
            this._set_default_value(record);
            return record._values[this.name];
        },
        set_default: function(record, value) {
            // value is a list of id
            if ((value instanceof Array) && !isNaN(parseInt(value[0], 10))) {
                this.set(record, value);
                record._changed[this.name] = true;
                return;
            }
            var group = record._values[this.name];
            var fields = {};
            if (group !== undefined) {
                fields = jQuery.extend({}, group.mode.fields);
                // TODO destroy and unconnect
            } else if (record.model.name == this.description.relation) {
                fields = record.model.fields;
            }
            if (!jQuery.isEmptyObject(fields)) {
                for (var name in fields) {
                    if (fields.hasOwnProperty(name)) {
                        fields[name] = fields[name].description;
                    }
                }
            }
            var prm = jQuery.when();
            prm.pipe(function() {
                return fields;
            });
            if (!jQuery.isEmptyObject(value)) {
                var context = this.get_context();
                var field_names = {};
                for (var val in value) {
                    if (!value.hasOwnProperty(val)) {
                        continue;
                    }
                    for (var fieldname in val) {
                        if (!val.hasOwnProperty(fieldname)) {
                            continue;
                        }
                        field_names[fieldname] = true;
                    }
                }
                if (!jQuery.isEmptyObject(field_names)) {
                    var args = {
                        'method': 'model.' + this.description.relation +
                            '.fields_get',
                        'params': [Object.keys(field_names), context]
                    };
                    prm = Sao.rpc(args, record.model.session);
                    prm.pipe(function(new_fields) {
                        return jQuery.extend(fields, new_fields);
                    });
                }
            }
            var set_value = function(fields) {
                var group = Sao.Group(new Sao.Model(this.description.relation),
                        this.context, []);
                group.parent = record;
                group.parent_name = this.description.relation_field;
                group.child_name = this.name;
                group.model.add_fields(fields);
                if (record._values[this.name] !== undefined) {
                    for (var i = 0, len = record._values[this.name].length;
                            i < len; i++) {
                        var r = record._values[this.name][i];
                        if (r.id >= 0) {
                            group.record_deleted.push(r);
                        }
                    }
                    jQuery.extend(group.record_deleted,
                            record._values[this.name].record_deleted);
                    jQuery.extend(group.record_removed,
                            record._values[this.name].record_removed);
                }
                record._values[this.name] = group;
                for (var val in value) {
                    if (!value.hasOwnProperty(val)) {
                        continue;
                    }
                    var new_record = group.new_(false);
                    new_record.set_default(val);
                    group.add(new_record);
                }
            };
            prm.done(set_value.bind(this));
        },
        _set_default_value: function(record) {
            if (record._values[this.name] !== undefined) {
                return;
            }
            var group = Sao.Group(new Sao.Model(this.description.relation),
                    this.context, []);
            group.parent = record;
            group.parent_name = this.description.relation_field;
            group.child_name = this.name;
            if (record.model.name == this.description.relation) {
                group.fields = record.model.fields;
            }
            record._values[this.name] = group;
        }
    });

    Sao.field.Many2Many = Sao.class_(Sao.field.One2Many, {
        set: function(record, value) {
            var group = record._values[this.name];
            var fields = {};
            if (group !== undefined) {
                fields = jQuery.extend({}, group.model.fields);
                // TODO destroy and unconnect
            } else if (record.model.name == this.description.relation) {
                fields = record.model.fields;
            }
            group = Sao.Group(new Sao.Model(this.description.relation),
                this.context, []);
            group.parent = record;
            group.parent_name = this.description.relation_field;
            group.child_name = this.name;
            group.model.fields = fields;
            if (record._values[this.name] !== undefined) {
                jQuery.extend(group.record_removed, record._values[this.name]);
                jQuery.extend(group.record_deleted,
                    record._values[this.name].record_deleted);
                jQuery.extend(group.record_removed,
                    record._values[this.name].record_removed);
            }
            record._values[this.name] = group;
            group.load(value);
        }
    });
}());
